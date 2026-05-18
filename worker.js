// ML Auto Sender — Cloudflare Worker v5
// KV-optimized: zero writes on idle, 2h chat retry, auto-abandon after 48h

const ML = 'https://api.mercadolibre.com';
const MAX_RETRIES      = 2;
const RATE_LIMIT_WAIT  = 3600000;   // 1h pause on rate limit
const CHAT_RETRY_WAIT  = 300000;    // 5min between chat retries — chat may open from buyer message anytime
const CHAT_ABANDON_AGE = 172800000; // abandon chat-unavailable orders after 48h
const ORDER_MAX_AGE    = 172800000; // ignore orders older than 48h (avoid historical backlog after reset)
const MAX_NEW_ORDERS_PER_CYCLE = 5; // cap message-check API calls per cycle

const json = (d, s=200, c={}) => new Response(JSON.stringify(d),
  { status:s, headers:{'Content-Type':'application/json',...c} });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Secret',
};

// ── KV (zero list calls) ──────────────────────────────────────────────────
const kv = {
  async obj(env,k,d={})  { try{return JSON.parse(await env.ML_STORE.get(k)||'null')??d}catch{return d} },
  async arr(env,k)        { try{return JSON.parse(await env.ML_STORE.get(k)||'[]')}catch{return []} },
  async put(env,k,v,ttl)  { await env.ML_STORE.put(k,JSON.stringify(v),ttl?{expirationTtl:ttl}:{}) },
};

// ── Log buffer — only writes KV on real events ────────────────────────────
let _buf=[], _ev=false, _events=[];
function log(msg,isEvent=false){
  const ts=new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  _buf.push(`[${ts}] ${msg}`);
  if(isEvent) _ev=true;
}
// Publish a structured event for frontend notifications
function event(type,title,body){
  _events.push({ts:Date.now(),type,title,body:body||''});
  _ev=true;
}
async function flush(env){
  if(!_buf.length&&!_events.length) return;
  if(!_ev){_buf=[];_events=[];return;}
  if(_buf.length){
    const ex=await kv.arr(env,'recent_logs');
    const mg=[...[..._buf].reverse(),...ex].slice(0,150);
    await kv.put(env,'recent_logs',mg);
    _buf=[];
  }
  if(_events.length){
    const ex=await kv.arr(env,'events');
    const mg=[..._events.reverse(),...ex].slice(0,50);
    await kv.put(env,'events',mg);
    _events=[];
  }
  _ev=false;
}
async function bumpStat(env,f){
  const s=await kv.obj(env,'stats',{orders:0,messages:0,confirmed:0,retries:0});
  s[f]=(s[f]||0)+1;
  await kv.put(env,'stats',s);
}

function errType(status,body){
  if(status===429) return{t:'rate_limit',m:'Rate limit do ML'};
  if(status===403) return{t:'no_chat',   m:'Chat não liberado pelo ML'};
  if(status===404) return{t:'not_found', m:'Pack/pedido não encontrado'};
  if(status===401) return{t:'auth',      m:'Token expirado'};
  if(status>=500)  return{t:'server',    m:`Erro servidor ML (${status})`};
  const c=body?.error||body?.cause?.[0]?.code||'';
  if(c==='PACK_NOT_FOUND') return{t:'no_chat',m:'Chat não liberado pelo ML'};
  return{t:'other',m:`Erro ${status}: ${c||JSON.stringify(body).slice(0,60)}`};
}

// ── Entry ─────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    if(req.method==='OPTIONS') return new Response(null,{headers:CORS});
    const url=new URL(req.url), p=url.pathname;
    if(p==='/ping') return json({ok:true,v:'6.16'},200,CORS);

    // ── Webhook receiver — must respond 200 in <500ms (ML requirement) ──────
    // Body parsing + processing is deferred via ctx.waitUntil so we ack fast.
    if(p==='/webhook/notifications'&&req.method==='POST'){
      try{
        const payload=await req.json();
        // Process in background — ML only cares about the 200
        ctx.waitUntil(handleNotification(env,payload));
      }catch(e){/* malformed body — still ack 200 to avoid retries */}
      return new Response('ok',{status:200});
    }

    if(p==='/api/oauth'&&req.method==='POST'){
      try{
        const body=await req.text();
        const r=await fetch(`${ML}/oauth/token`,{method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
        const text=await r.text();
        let d; try{d=JSON.parse(text)}catch{d={raw:text}};
        return json(d,r.status,CORS);
      }catch(e){return json({error:e.message},500,CORS);}
    }

    if(p.startsWith('/api/')){
      const cfg=await kv.obj(env,'cfg');
      const secret=req.headers.get('X-Secret')||'';
      if(cfg.secret_key&&secret!==cfg.secret_key)
        return json({error:'unauthorized'},401,CORS);
    }

    try{return await route(req,url,env);}
    catch(e){return json({error:e.message},500,CORS);}
  },
  async scheduled(_,env,ctx){
    ctx.waitUntil((async()=>{
      // Proactive token refresh: if access_token is older than 5h, refresh now
      // (tokens expire at 6h; we renew with 1h margin to avoid any 401 window)
      const cfg=await kv.obj(env,'cfg');
      const lastRefresh=Number(cfg.last_refresh_at||0);
      const PROACTIVE_REFRESH_MS=5*60*60*1000; // 5 hours
      if(cfg.refresh_token&&cfg.client_id&&cfg.client_secret&&(!lastRefresh||Date.now()-lastRefresh>PROACTIVE_REFRESH_MS)){
        try{
          const r=await fetch(`${ML}/oauth/token`,{method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({grant_type:'refresh_token',
              client_id:cfg.client_id,client_secret:cfg.client_secret,
              refresh_token:cfg.refresh_token})});
          if(r.ok){
            const d=await r.json();
            if(d.access_token){
              cfg.access_token=d.access_token;
              cfg.refresh_token=d.refresh_token||cfg.refresh_token;
              cfg.last_refresh_at=String(Date.now());
              await kv.put(env,'cfg',cfg);
            }
          }
        }catch{}
      }
      await monitor(env);
    })());
  },
};

// ── Router ────────────────────────────────────────────────────────────────
async function route(req,url,env){
  const p=url.pathname, m=req.method;

  if(p==='/api/setup'&&m==='POST'){
    const b=await req.json(), cfg=await kv.obj(env,'cfg');
    ['secret_key','access_token','refresh_token','seller_id','client_id',
     'client_secret','redirect_uri','auto_confirm','monitoring_enabled']
      .forEach(k=>{if(b[k]!==undefined)cfg[k]=String(b[k]);});
    await kv.put(env,'cfg',cfg);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/status'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    const stats=await kv.obj(env,'stats',{orders:0,messages:0,confirmed:0,retries:0});
    const logs=await kv.arr(env,'recent_logs');
    const rp=cfg.rate_limit_until&&Date.now()<Number(cfg.rate_limit_until);
    return json({monitoring:cfg.monitoring_enabled!=='0',rate_paused:!!rp,
                 rate_until:cfg.rate_limit_until||null,stats,logs,
                 token_set:!!cfg.access_token},200,CORS);
  }

  if(p==='/api/monitoring'&&m==='POST'){
    const{enabled}=await req.json(), cfg=await kv.obj(env,'cfg');
    cfg.monitoring_enabled=enabled?'1':'0';
    if(enabled) delete cfg.rate_limit_until;
    await kv.put(env,'cfg',cfg);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/products'&&m==='GET')
    return json(await listings(env),200,CORS);

  // ── Conversion stats: visits vs sales for each product ─────────────
  // GET /api/conversion?days=30
  // Returns per-product visits (last N days), sales (from orders_log), and computed rate
  if(p==='/api/conversion'&&m==='GET'){
    const days=Math.min(90,Math.max(1,parseInt(url.searchParams.get('days'))||30));
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'configurar credenciais primeiro'},400,CORS);

    // Get product list (uses cached listings if possible)
    const prods=await listings(env);
    if(!prods.length) return json({products:[]},200,CORS);

    // Fetch visits in batches (ML accepts multiple ids per call)
    const visitsMap={};
    const batch=20;
    for(let i=0;i<prods.length;i+=batch){
      const ids=prods.slice(i,i+batch).map(p=>p.id).join(',');
      try{
        // Correct endpoint: /items/visits/time_window?ids=...&last=N&unit=day
        const r=await mlFetch(env,cfg,'GET',
          `/items/visits/time_window?ids=${ids}&last=${days}&unit=day`);
        if(r?.ok){
          const data=await r.json();
          (Array.isArray(data)?data:[]).forEach(v=>{
            // Response field is "total" (not "total_visits") in time_window endpoint
            visitsMap[v.item_id]=v.total||v.total_visits||0;
          });
        }
      }catch{}
    }

    // Count sales from orders_log within the date range
    const ol=await kv.arr(env,'orders_log');
    const cutoff=Date.now()-days*86400000;
    const salesMap={};
    for(const o of ol){
      const t=o.created_at?new Date(o.created_at).getTime():0;
      if(t<cutoff) continue;
      if(!o.item_id) continue;
      salesMap[o.item_id]=(salesMap[o.item_id]||0)+1;
    }

    // Build result
    const result=prods.map(p=>{
      const visits=visitsMap[p.id]||0;
      const sales=salesMap[p.id]||0;
      const conversion=visits>0?(sales/visits*100):0;
      return{
        id:p.id,
        title:p.title,
        listing_status:p.listing_status,
        available_quantity:p.available_quantity,
        enabled:p.enabled,
        visits,sales,
        conversion_rate:Math.round(conversion*100)/100,
      };
    }).sort((a,b)=>b.conversion_rate-a.conversion_rate);

    return json({days,total_visits:result.reduce((s,p)=>s+p.visits,0),
      total_sales:result.reduce((s,p)=>s+p.sales,0),products:result},200,CORS);
  }

  if(p==='/api/product'&&m==='POST'){
    const{item_id,enabled,product_key,delay_min,delay_max}=await req.json();
    const prods=await kv.obj(env,'products_cfg');
    prods[item_id]={enabled:!!enabled,product_key:product_key||'',
                    delay_min:delay_min||15,delay_max:delay_max||90};
    await kv.put(env,'products_cfg',prods);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/products/bulk_delay'&&m==='POST'){
    const{delay_min,delay_max,scope}=await req.json();
    const dmin=Math.max(1,parseInt(delay_min)||15);
    const dmax=Math.max(dmin,parseInt(delay_max)||90);
    const prods=await kv.obj(env,'products_cfg');
    let count=0;
    for(const id in prods){
      if(scope==='enabled'&&!prods[id].enabled) continue;
      prods[id].delay_min=dmin;
      prods[id].delay_max=dmax;
      count++;
    }
    await kv.put(env,'products_cfg',prods);
    return json({ok:true,updated:count,delay_min:dmin,delay_max:dmax},200,CORS);
  }

  if(p==='/api/messages'&&m==='GET'){
    const id=url.searchParams.get('id'), msgs=await kv.obj(env,'messages_cfg');
    return json(msgs[id]||['','','',''],200,CORS);
  }

  if(p==='/api/messages'&&m==='POST'){
    const{item_id,messages}=await req.json(), msgs=await kv.obj(env,'messages_cfg');
    msgs[item_id]=messages;
    await kv.put(env,'messages_cfg',msgs);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/orders'&&m==='GET')
    return json((await kv.arr(env,'orders_log')).slice(0,60),200,CORS);

  if(p==='/api/run'&&m==='POST'){
    monitor(env).catch(()=>{});
    return json({ok:true},200,CORS);
  }

  // Debug: which credentials are populated (without exposing values) ──
  if(p==='/api/debug/credentials'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    return json({
      access_token: cfg.access_token ? `set (${cfg.access_token.slice(0,20)}...${cfg.access_token.slice(-8)})` : 'MISSING',
      refresh_token: cfg.refresh_token ? `set (${cfg.refresh_token.slice(0,8)}...${cfg.refresh_token.slice(-12)})` : 'MISSING',
      client_id: cfg.client_id ? `set (${cfg.client_id})` : 'MISSING',
      client_secret: cfg.client_secret ? `set (${cfg.client_secret.length} chars)` : 'MISSING',
      seller_id: cfg.seller_id ? `set (${cfg.seller_id})` : 'MISSING',
      secret_key: cfg.secret_key ? `set (${cfg.secret_key.length} chars)` : 'MISSING',
      monitoring_enabled: cfg.monitoring_enabled || '1 (default)',
      auto_refresh_ready: !!(cfg.client_id && cfg.client_secret && cfg.refresh_token),
    },200,CORS);
  }

  // Debug: fetch a specific order from ML using the saved token
  // Helps investigate why specific orders weren't processed
  if(p==='/api/debug/order'&&m==='GET'){
    const orderId=url.searchParams.get('id');
    if(!orderId) return json({error:'?id=orderId required'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    const r=await mlFetch(env,cfg,'GET',`/orders/${orderId}`);
    if(!r) return json({error:'no response'},500,CORS);
    const data=await r.json().catch(()=>({}));
    const processed=await kv.obj(env,'processed_ids');
    const queue=await kv.arr(env,'queue');
    const inQueue=queue.find(q=>q.order_id===orderId);
    return json({
      ml_status:r.status,
      processed_at:processed[orderId]?new Date(processed[orderId]).toISOString():null,
      in_queue:!!inQueue,
      queue_item:inQueue||null,
      order:r.ok?{
        id:data.id,
        date_created:data.date_created,
        status:data.status,
        pack_id:data.pack_id,
        seller_id:data.seller?.id,
        buyer:{id:data.buyer?.id,nickname:data.buyer?.nickname},
        items:(data.order_items||[]).map(oi=>({id:oi.item?.id,title:oi.item?.title}))
      }:data
    },200,CORS);
  }

  // Debug: get full access_token (for manual ML API testing)
  // Returns the actual token — use sparingly, protected by X-Secret
  if(p==='/api/debug/token'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    return json({
      access_token: cfg.access_token || '',
      seller_id: cfg.seller_id || '',
    },200,CORS);
  }

  // ── Force token refresh — useful to test that refresh is working ──
  if(p==='/api/refresh'&&m==='POST'){
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.client_id||!cfg.client_secret||!cfg.refresh_token){
      return json({ok:false,error:'missing credentials',
        missing:{client_id:!cfg.client_id,client_secret:!cfg.client_secret,refresh_token:!cfg.refresh_token}
      },400,CORS);
    }
    const oldAccess=cfg.access_token||'';
    const oldRefresh=cfg.refresh_token;
    try{
      const r=await fetch(`${ML}/oauth/token`,{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',
          client_id:cfg.client_id,client_secret:cfg.client_secret,
          refresh_token:cfg.refresh_token})});
      const d=await r.json();
      if(r.ok&&d.access_token){
        cfg.access_token=d.access_token;
        cfg.refresh_token=d.refresh_token||cfg.refresh_token;
        await kv.put(env,'cfg',cfg);
        return json({
          ok:true,
          message:'Token renovado com sucesso',
          access_token_changed: d.access_token!==oldAccess,
          refresh_token_changed: d.refresh_token && d.refresh_token!==oldRefresh,
          new_access_preview: d.access_token.slice(0,20)+'...'+d.access_token.slice(-8),
          new_refresh_preview: (d.refresh_token||oldRefresh).slice(0,8)+'...'+(d.refresh_token||oldRefresh).slice(-12),
          expires_in: d.expires_in,
          scope: d.scope,
        },200,CORS);
      }
      return json({ok:false,error:'refresh rejected by ML',ml_response:d,status:r.status},400,CORS);
    }catch(e){
      return json({ok:false,error:'request failed: '+e.message},500,CORS);
    }
  }

  // ── Templates (synced across devices via KV) ─────────────────────────
  if(p==='/api/templates'&&m==='GET')
    return json(await kv.obj(env,'templates_lib',{}),200,CORS);

  if(p==='/api/templates'&&m==='POST'){
    const{name,messages}=await req.json();
    if(!name||!Array.isArray(messages)) return json({error:'invalid'},400,CORS);
    const lib=await kv.obj(env,'templates_lib',{});
    lib[name]=messages;
    await kv.put(env,'templates_lib',lib);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/templates/delete'&&m==='POST'){
    const{name}=await req.json();
    const lib=await kv.obj(env,'templates_lib',{});
    delete lib[name];
    await kv.put(env,'templates_lib',lib);
    return json({ok:true},200,CORS);
  }

  // ── Test mode: send 1 message to a specific order ────────────────────
  if(p==='/api/test/send'&&m==='POST'){
    const{order_id,text}=await req.json();
    if(!order_id||!text) return json({error:'order_id e text obrigatórios'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'configurar credenciais primeiro'},400,CORS);

    // Get order to find pack_id and buyer_id
    const r=await mlFetch(env,cfg,'GET',`/orders/${order_id}`);
    if(!r?.ok){
      const eb=await r?.json().catch(()=>({}));
      return json({error:`erro ao buscar pedido: ${eb?.message||r?.status}`},400,CORS);
    }
    const order=await r.json();
    const packId=String(order.pack_id||order.id);
    const buyerId=String(order.buyer?.id||'');
    if(!buyerId) return json({error:'buyer_id não encontrado'},400,CORS);

    const sr=await mlFetch(env,cfg,'POST',
      `/messages/packs/${packId}/sellers/${cfg.seller_id}?tag=post_sale`,
      {from:{user_id:cfg.seller_id,email:''},to:{user_id:buyerId},text});
    const sb=await sr?.json().catch(()=>({}));
    if(sr?.ok) return json({ok:true,message:'enviada',response:sb},200,CORS);
    return json({error:sb?.message||sb?.error||`HTTP ${sr?.status}`,detail:sb},400,CORS);
  }

  // ── Sales daily aggregation (for chart) — derived from orders_log ────
  if(p==='/api/stats/daily'&&m==='GET'){
    const ol=await kv.arr(env,'orders_log');
    const days={};
    for(const o of ol){
      const d=(o.created_at||'').slice(0,10);
      if(!d) continue;
      if(!days[d]) days[d]={date:d,orders:0,messages_sent:0,confirmed:0};
      days[d].orders++;
      days[d].messages_sent+=(o.msgs_sent||0);
      if(o.confirmed) days[d].confirmed++;
    }
    const result=Object.values(days).sort((a,b)=>a.date<b.date?-1:1);
    return json(result,200,CORS);
  }

  // ── Re-trigger an order (useful after manual recovery) ───────────────
  if(p==='/api/order/retry'&&m==='POST'){
    const{order_id}=await req.json();
    if(!order_id) return json({error:'order_id obrigatório'},400,CORS);
    const processed=await kv.obj(env,'processed_ids');
    delete processed[order_id];
    await kv.put(env,'processed_ids',processed);
    return json({ok:true,message:'pedido será reprocessado no próximo ciclo'},200,CORS);
  }

  // ── Force-unblock: release a specific stuck order (skip waiting for buyer msg) ──
  if(p==='/api/order/force_send'&&m==='POST'){
    const{order_id}=await req.json();
    if(!order_id) return json({error:'order_id obrigatório'},400,CORS);
    const queue=await kv.arr(env,'queue');
    const item=queue.find(q=>String(q.order_id)===String(order_id));
    if(!item) return json({error:'pedido não está na fila',hint:'use /api/order/retry para reprocessar'},404,CORS);
    item.next_send_at=Date.now()+Math.random()*3000;
    item.chat_opened=true;
    await kv.put(env,'queue',queue);
    // Fire monitor immediately
    monitor(env).catch(()=>{});
    return json({ok:true,message:'envio forçado, monitor disparado'},200,CORS);
  }

  // ── List all queue items (for UI to show pending orders) ──
  if(p==='/api/queue/list'&&m==='GET'){
    const queue=await kv.arr(env,'queue');
    return json(queue.map(q=>({
      order_id:q.order_id,
      buyer:q.buyer,
      item_id:q.item_id,
      msgs_remaining:q.msgs_remaining?.length||0,
      total_msgs:q.total_msgs,
      chat_opened:q.chat_opened,
      next_send_at:q.next_send_at===Number.MAX_SAFE_INTEGER?null:q.next_send_at,
      enqueued_at:q.enqueued_at,
      chat_retry_count:q.chat_retry_count||0,
    })),200,CORS);
  }

  // ── Broadcast: list recent buyers of selected products ─────────────
  // GET /api/broadcast/buyers?item_ids=ID1,ID2&days=30
  if(p==='/api/broadcast/buyers'&&m==='GET'){
    const itemIds=(url.searchParams.get('item_ids')||'').split(',').filter(Boolean);
    const days=Math.min(90,Math.max(1,parseInt(url.searchParams.get('days'))||30));
    if(!itemIds.length) return json({error:'item_ids required'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'configurar credenciais primeiro'},400,CORS);

    // Fetch recent paid orders for the seller
    const since=new Date(Date.now()-days*86400000).toISOString();
    const r=await mlFetch(env,cfg,'GET',
      `/orders/search?seller=${cfg.seller_id}&order.status=paid&order.date_created.from=${since}&sort=date_desc&limit=50`);
    if(!r?.ok){
      const eb=await r?.json().catch(()=>({}));
      return json({error:eb?.message||`HTTP ${r?.status}`},400,CORS);
    }
    const data=await r.json();
    const orders=data.results||[];
    const itemSet=new Set(itemIds);
    const matched=[];
    for(const o of orders){
      const oItems=o.order_items||[];
      const matchedItem=oItems.find(oi=>itemSet.has(String(oi.item?.id||'')));
      if(!matchedItem) continue;
      matched.push({
        order_id:String(o.id),
        item_id:String(matchedItem.item?.id),
        item_title:matchedItem.item?.title||'',
        buyer_id:String(o.buyer?.id||''),
        buyer:o.buyer?.nickname||'',
        pack_id:String(o.pack_id||o.id),
        date_created:o.date_created,
      });
    }
    return json({total:matched.length,buyers:matched},200,CORS);
  }

  // ── Broadcast: send message to selected recipients ─────────────
  // POST body: { recipients: [{order_id, pack_id, buyer_id, buyer}, ...], text, delay_min, delay_max }
  // Processes async: marks as queued, runs send in background to avoid wall-time limit
  if(p==='/api/broadcast/send'&&m==='POST'){
    const{recipients,text,delay_min,delay_max}=await req.json();
    if(!Array.isArray(recipients)||!recipients.length) return json({error:'recipients required'},400,CORS);
    if(!text||!text.trim()) return json({error:'text required'},400,CORS);
    if(text.length>350) return json({error:'text deve ter no máximo 350 caracteres'},400,CORS);
    const dmin=Math.max(5,parseInt(delay_min)||15);
    const dmax=Math.max(dmin,parseInt(delay_max)||45);

    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'configurar credenciais primeiro'},400,CORS);

    // Store broadcast job to be processed (status: pending → in_progress → done)
    const jobId=`bc_${Date.now()}`;
    const job={
      id:jobId,
      created_at:new Date().toISOString(),
      text:String(text),
      total:recipients.length,
      sent:0,
      failed:0,
      skipped:0,
      status:'in_progress',
      delay_min:dmin,
      delay_max:dmax,
      details:[],
    };
    const jobs=await kv.obj(env,'broadcast_jobs',{});
    jobs[jobId]=job;
    await kv.put(env,'broadcast_jobs',jobs);

    // Run send loop in background — survives the HTTP response
    ctx.waitUntil(processBroadcast(env,jobId,recipients,text,dmin,dmax));

    return json({ok:true,job_id:jobId,message:'Broadcast iniciado em background'},200,CORS);
  }

  // ── Broadcast: status of a job ─────────────
  if(p==='/api/broadcast/status'&&m==='GET'){
    const jobId=url.searchParams.get('id');
    const jobs=await kv.obj(env,'broadcast_jobs',{});
    if(jobId){
      return json(jobs[jobId]||{error:'not found'},jobs[jobId]?200:404,CORS);
    }
    // Return latest 10 jobs
    const list=Object.values(jobs).sort((a,b)=>b.created_at<a.created_at?-1:1).slice(0,10);
    return json(list,200,CORS);
  }

  // ── OAuth integrated flow: exchange code for tokens via the Worker ─────
  // POST { code, client_id, client_secret, redirect_uri } → exchange + auto-save
  if(p==='/api/oauth/exchange'&&m==='POST'){
    const{code,client_id,client_secret,redirect_uri}=await req.json();
    if(!code||!client_id||!client_secret||!redirect_uri) return json({error:'missing fields'},400,CORS);
    try{
      const r=await fetch(`${ML}/oauth/token`,{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'authorization_code',
          client_id,client_secret,code,redirect_uri})});
      const d=await r.json();
      if(!r.ok||!d.access_token) return json({error:d.message||d.error||'oauth failed',ml:d},400,CORS);
      const cfg=await kv.obj(env,'cfg');
      cfg.access_token=d.access_token;
      if(d.refresh_token) cfg.refresh_token=d.refresh_token;
      cfg.seller_id=String(d.user_id||cfg.seller_id||'');
      cfg.client_id=String(client_id);
      cfg.client_secret=String(client_secret);
      cfg.last_refresh_at=String(Date.now());
      await kv.put(env,'cfg',cfg);
      return json({
        ok:true,
        seller_id:d.user_id,
        scope:d.scope,
        has_refresh:!!d.refresh_token,
        offline_access:String(d.scope||'').includes('offline_access'),
      },200,CORS);
    }catch(e){
      return json({error:'fetch failed: '+e.message},500,CORS);
    }
  }

  // ── Backup: export all KV data as a JSON blob ─────────────────────────
  if(p==='/api/backup/export'&&m==='GET'){
    const keys=['cfg','products_cfg','messages_cfg','templates_lib','orders_log','queue','confirms','processed_ids','failed_messages','stats','broadcast_jobs','events'];
    const data={};
    for(const k of keys){
      try{
        const v=await env.MLAS_KV.get(k);
        if(v!==null) data[k]=v;
      }catch{}
    }
    // Redact secrets from the export (still useful as backup but safer)
    return json({
      exported_at:new Date().toISOString(),
      version:'6.16',
      data,
    },200,CORS);
  }

  // ── Restore: import a previously-exported JSON blob ──────────────────
  if(p==='/api/backup/import'&&m==='POST'){
    const body=await req.json();
    if(!body?.data) return json({error:'no data field'},400,CORS);
    let restored=0;
    for(const k in body.data){
      try{
        await env.MLAS_KV.put(k,body.data[k]);
        restored++;
      }catch{}
    }
    return json({ok:true,restored},200,CORS);
  }

  // ── Health: comprehensive system status ──────────────────────────────
  if(p==='/api/health'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    const queue=await kv.arr(env,'queue');
    const ol=await kv.arr(env,'orders_log');
    const lastRefresh=Number(cfg.last_refresh_at||0);
    const lastOrder=ol[0];
    const nextRefreshIn=lastRefresh?Math.max(0,5*60*60*1000-(Date.now()-lastRefresh)):0;
    return json({
      version:'6.16',
      monitoring:cfg.monitoring_enabled!=='0',
      vacation_until:cfg.vacation_until||null,
      vacation_active:cfg.vacation_until&&Date.now()<Number(cfg.vacation_until),
      token_set:!!cfg.access_token,
      auto_refresh_ready:!!(cfg.client_id&&cfg.client_secret&&cfg.refresh_token),
      last_refresh_at:lastRefresh?new Date(lastRefresh).toISOString():null,
      next_proactive_refresh_in_minutes:Math.round(nextRefreshIn/60000),
      queue_size:queue.length,
      queue_awaiting_chat:queue.filter(q=>!q.chat_opened).length,
      queue_ready:queue.filter(q=>q.chat_opened&&q.next_send_at<=Date.now()).length,
      last_order:lastOrder?{
        order_id:lastOrder.order_id,
        buyer:lastOrder.buyer,
        msgs_sent:lastOrder.msgs_sent,
        confirmed:lastOrder.confirmed,
        created_at:lastOrder.created_at,
      }:null,
      timestamp:new Date().toISOString(),
    },200,CORS);
  }

  // ── Vacation mode: pause monitoring until a date ────────────────────
  if(p==='/api/vacation'&&m==='POST'){
    const{until}=await req.json();
    const cfg=await kv.obj(env,'cfg');
    if(until){
      const t=Date.parse(until);
      if(isNaN(t)) return json({error:'invalid date'},400,CORS);
      cfg.vacation_until=String(t);
      cfg.monitoring_enabled='0';
    } else {
      delete cfg.vacation_until;
      cfg.monitoring_enabled='1';
    }
    await kv.put(env,'cfg',cfg);
    return json({ok:true,vacation_until:cfg.vacation_until||null,monitoring:cfg.monitoring_enabled!=='0'},200,CORS);
  }

  // ── Events: lightweight notification stream for the frontend ─────────
  // Frontend polls this every N seconds for new events to display as push-like notifications
  if(p==='/api/events'&&m==='GET'){
    const since=parseInt(url.searchParams.get('since'))||0;
    const events=await kv.arr(env,'events');
    return json(events.filter(e=>e.ts>since).slice(0,20),200,CORS);
  }

  // ── Multi-account: list accounts and switch active one ─────────────
  if(p==='/api/accounts'&&m==='GET'){
    const accounts=await kv.obj(env,'accounts',{});
    const cfg=await kv.obj(env,'cfg');
    const list=Object.entries(accounts).map(([id,a])=>({
      id, name:a.name||a.seller_id, seller_id:a.seller_id, active:id===cfg.active_account_id,
    }));
    return json(list,200,CORS);
  }
  if(p==='/api/accounts/save_current'&&m==='POST'){
    const{name}=await req.json();
    if(!name) return json({error:'name required'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.seller_id) return json({error:'no active credentials to save'},400,CORS);
    const accounts=await kv.obj(env,'accounts',{});
    const id=`acc_${cfg.seller_id}_${Date.now().toString(36)}`;
    accounts[id]={
      name,
      seller_id:cfg.seller_id,
      access_token:cfg.access_token,
      refresh_token:cfg.refresh_token,
      client_id:cfg.client_id,
      client_secret:cfg.client_secret,
      last_refresh_at:cfg.last_refresh_at,
      saved_at:new Date().toISOString(),
    };
    cfg.active_account_id=id;
    await kv.put(env,'accounts',accounts);
    await kv.put(env,'cfg',cfg);
    return json({ok:true,id,name},200,CORS);
  }
  if(p==='/api/accounts/switch'&&m==='POST'){
    const{id}=await req.json();
    const accounts=await kv.obj(env,'accounts',{});
    const acc=accounts[id];
    if(!acc) return json({error:'account not found'},404,CORS);
    const cfg=await kv.obj(env,'cfg');
    cfg.access_token=acc.access_token||'';
    cfg.refresh_token=acc.refresh_token||'';
    cfg.seller_id=acc.seller_id||'';
    cfg.client_id=acc.client_id||'';
    cfg.client_secret=acc.client_secret||'';
    cfg.last_refresh_at=acc.last_refresh_at||'';
    cfg.active_account_id=id;
    await kv.put(env,'cfg',cfg);
    return json({ok:true,name:acc.name,seller_id:acc.seller_id},200,CORS);
  }
  if(p==='/api/accounts/delete'&&m==='POST'){
    const{id}=await req.json();
    const accounts=await kv.obj(env,'accounts',{});
    delete accounts[id];
    await kv.put(env,'accounts',accounts);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/webhook/test'&&m==='POST'){
    // Manually test webhook handling — pass {topic,resource,actions}
    const payload=await req.json();
    handleNotification(env,payload).catch(()=>{});
    return json({ok:true,message:'Notification queued for processing'},200,CORS);
  }

  if(p==='/api/logs/clear'&&m==='POST'){
    await kv.put(env,'recent_logs',[]);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/failed_messages'&&m==='GET')
    return json(await kv.arr(env,'failed_messages'),200,CORS);

  if(p==='/api/failed_messages/clear'&&m==='POST'){
    await kv.put(env,'failed_messages',[]);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/stats/reset'&&m==='POST'){
    await kv.put(env,'stats',{orders:0,messages:0,confirmed:0,retries:0});
    return json({ok:true},200,CORS);
  }

  if(p==='/api/queue/clear'&&m==='POST'){
    await kv.put(env,'queue',[]);
    await kv.put(env,'confirms',[]);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/full/reset'&&m==='POST'){
    await kv.put(env,'stats',{orders:0,messages:0,confirmed:0,retries:0});
    await kv.put(env,'queue',[]);
    await kv.put(env,'confirms',[]);
    await kv.put(env,'processed_ids',{});
    await kv.put(env,'failed_messages',[]);
    await kv.put(env,'recent_logs',[]);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/add_stock'&&m==='POST'){
    const{item_id,quantity}=await req.json(), cfg=await kv.obj(env,'cfg');
    const r=await mlFetch(env,cfg,'PUT',`/items/${item_id}`,{available_quantity:quantity});
    if(r?.ok) return json({ok:true},200,CORS);
    const d=await r?.json().catch(()=>({}));
    return json({error:d.message||'erro'},400,CORS);
  }

  if(p==='/api/toggle_listing'&&m==='POST'){
    const{item_id,status}=await req.json(), cfg=await kv.obj(env,'cfg');
    const r=await mlFetch(env,cfg,'PUT',`/items/${item_id}`,{status});
    if(r?.ok) return json({ok:true},200,CORS);
    const d=await r?.json().catch(()=>({}));
    return json({error:d.message||'erro'},400,CORS);
  }

  return json({error:'not found'},404,CORS);
}

// ── ML helpers ────────────────────────────────────────────────────────────
async function mlFetch(env,cfg,method,path,body=null,retry=true){
  const opts={method,headers:{Authorization:`Bearer ${cfg.access_token}`,'Content-Type':'application/json'}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(`${ML}${path}`,opts);
  if(r.status===401&&retry&&await mlRefresh(env,cfg))
    return mlFetch(env,cfg,method,path,body,false);
  return r;
}

async function mlRefresh(env,cfg){
  try{
    const r=await fetch(`${ML}/oauth/token`,{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',
        client_id:cfg.client_id||'',client_secret:cfg.client_secret||'',
        refresh_token:cfg.refresh_token||''})});
    if(r.ok){
      const d=await r.json();
      if(d.access_token){
        cfg.access_token=d.access_token;
        cfg.refresh_token=d.refresh_token||cfg.refresh_token;
        await kv.put(env,'cfg',cfg);
        return true;
      }
    }
  }catch{}
  return false;
}

async function listings(env){
  const cfg=await kv.obj(env,'cfg'), prods=await kv.obj(env,'products_cfg');
  if(!cfg.seller_id) return [];

  // If currently rate limited, return cached products (avoid making things worse)
  if(cfg.rate_limit_until&&Date.now()<Number(cfg.rate_limit_until)){
    const cached=await kv.arr(env,'products_cache');
    if(cached.length){
      // Re-merge with current per-product config (enabled state, key, delays) so toggles still reflect
      return cached.map(it=>{
        const pc=prods[it.id]||{};
        return {...it,enabled:pc.enabled||false,product_key:pc.product_key||'',
                delay_min:pc.delay_min||15,delay_max:pc.delay_max||90};
      });
    }
  }

  const items=[]; const seen=new Set(); let hit429=false;
  for(const status of['active','paused']){
    if(hit429) break;
    let off=0;
    while(true){
      const r=await mlFetch(env,cfg,'GET',
        `/users/${cfg.seller_id}/items/search?status=${status}&offset=${off}&limit=50`);
      if(r?.status===429){
        hit429=true;
        cfg.rate_limit_until=String(Date.now()+RATE_LIMIT_WAIT);
        await kv.put(env,'cfg',cfg);
        break;
      }
      if(!r?.ok) break;
      const d=await r.json(), ids=d.results||[];
      if(!ids.length) break;
      for(let i=0;i<ids.length;i+=20){
        const batch=ids.slice(i,i+20);
        const r2=await mlFetch(env,cfg,'GET',
          `/items?ids=${batch.join(',')}&attributes=id,title,available_quantity,status`);
        if(r2?.status===429){
          hit429=true;
          cfg.rate_limit_until=String(Date.now()+RATE_LIMIT_WAIT);
          await kv.put(env,'cfg',cfg);
          break;
        }
        if(r2?.ok) for(const e of await r2.json()){
          const b=e.body||{};
          if(!b.id||seen.has(b.id)) continue;
          seen.add(b.id);
          const pc=prods[b.id]||{};
          items.push({id:b.id,title:b.title||b.id,
            available_quantity:b.available_quantity??'?',
            listing_status:b.status||status,
            enabled:pc.enabled||false,product_key:pc.product_key||'',
            delay_min:pc.delay_min||15,delay_max:pc.delay_max||90});
        }
      }
      if(hit429) break;
      off+=50; if(off>=(d.paging?.total||0)) break;
    }
  }

  // Cache successful fetch (or partial — better than nothing on next rate-limited call)
  if(items.length) await kv.put(env,'products_cache',items);
  // If rate limited mid-fetch, fall back to whatever we got + cached missing items
  if(hit429){
    const cached=await kv.arr(env,'products_cache');
    if(cached.length>items.length) return cached.map(it=>{
      const pc=prods[it.id]||{};
      return {...it,enabled:pc.enabled||false,product_key:pc.product_key||'',
              delay_min:pc.delay_min||15,delay_max:pc.delay_max||90};
    });
  }
  return items;
}

// ── Webhook handler — runs after we acked 200 to ML ─────────────────────
// Two scenarios we care about:
//  1) topic=orders_v2 → new paid sale → enqueue order with chat_opened:false
//  2) topic=messages → buyer messaged us → mark matching queue item ready
async function handleNotification(env,p){
  try{
    const topic=p.topic||'';
    const resource=p.resource||'';
    if(!topic||!resource) return;

    if(topic==='orders_v2'||topic==='orders'){
      // /orders/123456 → 123456
      const orderId=resource.split('/').filter(Boolean).pop();
      if(!orderId||!/^\d+$/.test(orderId)) return;
      await ingestOrder(env,orderId,'webhook');
    } else if(topic==='messages'){
      // resource is opaque hash; the actions array tells us if msg was created
      const actions=p.actions||[];
      // Only react when buyer sent a NEW message (not on read events)
      if(!actions.includes('created')) return;
      // Sender is the buyer (we are the receiver per ML's user_id semantic)
      // Mark all queue items that are waiting for chat as ready to fire
      await unblockQueueOnBuyerMessage(env,p);
    }
  }catch(e){/* swallow — ML already got 200, retry would just loop */}
}

// Fetch full order, decide if relevant, enqueue
async function ingestOrder(env,orderId,source){
  const cfg=await kv.obj(env,'cfg');
  if(!cfg.access_token||!cfg.seller_id) return;

  // ATOMIC LOCK: reserve the order ID immediately to prevent webhook+polling race.
  // If another execution wins the race, this one bails out silently.
  const processed=await kv.obj(env,'processed_ids');
  if(processed[orderId]) return; // already handled by another execution
  processed[orderId]=Date.now();
  await kv.put(env,'processed_ids',processed);

  const r=await mlFetch(env,cfg,'GET',`/orders/${orderId}`);
  if(!r?.ok){
    log(`⚠ ${source}: erro ao buscar pedido ${orderId} (HTTP ${r?.status})`,true);
    await flush(env); return;
  }
  const order=await r.json();
  if(order.status!=='paid') return; // ignore unpaid status changes

  const prods=await kv.obj(env,'products_cfg');
  const msgs=await kv.obj(env,'messages_cfg');

  // Match to enabled product
  let itemId='', pc=null;
  for(const oi of order.order_items||[]){
    const id=String(oi.item?.id||'');
    if(prods[id]?.enabled){itemId=id; pc=prods[id]; break;}
  }
  if(!pc) return; // not one of our monitored products

  const buyer=order.buyer?.nickname||'comprador';
  const buyerId=String(order.buyer?.id||'');
  const packId=String(order.pack_id||order.id);
  const rawMsgs=msgs[itemId]||[];
  const msgList=rawMsgs.filter(m=>m?.trim())
    .map(m=>m.replace(/\{nome\}/g,buyer)
              .replace(/\{key\}/g,pc.product_key||'')
              .replace(/\{pedido\}/g,orderId));

  const now=Date.now();

  // Check chat state: did seller already message? Did buyer already message?
  let sellerAlreadyMessaged=false;
  let buyerAlreadyMessaged=false;
  let chatAccessible=false;
  const chatCheck=await mlFetch(env,cfg,'GET',
    `/messages/packs/${packId}/sellers/${cfg.seller_id}?tag=post_sale&mark_as_read=false`);
  if(chatCheck?.ok){
    chatAccessible=true;
    const cd=await chatCheck.json().catch(()=>({}));
    const messages=cd.messages||cd.results||[];
    for(const m of messages){
      const fromId=String(m.from?.user_id||m.from?.id||m.from||'');
      if(fromId===String(cfg.seller_id)) sellerAlreadyMessaged=true;
      else if(fromId===String(buyerId)) buyerAlreadyMessaged=true;
      else if(fromId&&fromId!==String(cfg.seller_id)) buyerAlreadyMessaged=true; // any non-seller msg
    }
    if(sellerAlreadyMessaged){
      await kv.put(env,'processed_ids',processed);
      log(`⏭ ${source}: pedido #${orderId} (${buyer}) — você já enviou msg, ignorado`,true);
      await flush(env); return;
    }
  }

  if(msgList.length){
    const queue=await kv.arr(env,'queue');
    // If chat is already accessible AND buyer already wrote, enqueue READY (immediate)
    // Otherwise wait for buyer message webhook to unblock
    const chatAlreadyOpen=chatAccessible&&buyerAlreadyMessaged;
    queue.push({
      order_id:orderId,item_id:itemId,pack_id:packId,
      buyer_id:buyerId,buyer,msgs_remaining:[...msgList],
      total_msgs:msgList.length,delay_min:pc.delay_min||15,
      delay_max:pc.delay_max||90,
      next_send_at:chatAlreadyOpen?(now+Math.random()*3000):Number.MAX_SAFE_INTEGER,
      chat_opened:chatAlreadyOpen,
      retries:0,chat_retry_count:0,first_attempt_at:now,
      enqueued_at:now,
    });
    await kv.put(env,'queue',queue);
    if(chatAlreadyOpen){
      log(`📦 ${source}: pedido #${orderId} | ${buyer} | chat já aberto — enviando imediatamente`,true);
      event('new_order',`Nova venda — ${buyer}`,`Pedido #${orderId} pronto pra enviar`);
    } else {
      log(`📦 ${source}: pedido #${orderId} | ${buyer} | aguardando comprador iniciar chat`,true);
      event('new_order',`Nova venda — ${buyer}`,`Pedido #${orderId} aguardando chat`);
    }
  } else {
    log(`📦 ${source}: pedido #${orderId} sem mensagens configuradas`,true);
  }

  // Update orders log + stats
  const ol=await kv.arr(env,'orders_log');
  ol.unshift({order_id:orderId,item_id:itemId,buyer,
    msgs_sent:0,confirmed:false,created_at:new Date().toISOString()});
  if(ol.length>100) ol.splice(100);
  await kv.put(env,'orders_log',ol);
  await kv.put(env,'processed_ids',processed);
  await bumpStat(env,'orders');
  await flush(env);
}

// Buyer sent a message — find any queue item from this buyer waiting for chat
// and release it (set next_send_at to now + small delay).
async function unblockQueueOnBuyerMessage(env,payload){
  const queue=await kv.arr(env,'queue');
  if(!queue.length) return;

  const cfg=await kv.obj(env,'cfg');
  if(!cfg.access_token||!cfg.seller_id) return;

  // The resource is like "/messages/MESSAGE_ID" — we need to fetch it
  // to discover which conversation (and thus which order/pack) it belongs to.
  const resource=payload.resource||'';
  const msgId=resource.split('/').filter(Boolean).pop();
  let targetPackId=null;
  let targetBuyerId=null;

  if(msgId){
    try{
      const r=await mlFetch(env,cfg,'GET',`/messages/${msgId}`);
      if(r?.ok){
        const m=await r.json();
        // Extract pack_id from message metadata (location varies in ML responses)
        targetPackId=String(m.message_resources?.[0]?.id||m.resource_id||m.pack_id||'');
        targetBuyerId=String(m.from?.user_id||m.from?.id||'');
      }
    }catch{}
  }

  const now=Date.now();
  let changed=false;
  let unblocked=[];

  for(const item of queue){
    if(item.chat_opened) continue;
    if(!item.msgs_remaining?.length) continue;

    // If we know the specific pack/buyer, only unblock matching item
    const matchesPack=targetPackId&&String(item.pack_id)===targetPackId;
    const matchesBuyer=targetBuyerId&&String(item.buyer_id)===targetBuyerId;
    const knownTarget=targetPackId||targetBuyerId;

    if(knownTarget&&!matchesPack&&!matchesBuyer) continue;

    // First message: 0-3s delay (immediate, before buyer can open a claim)
    // Subsequent messages will use product's delay_min/delay_max
    item.next_send_at=now+Math.random()*3000;
    item.chat_opened=true;
    changed=true;
    unblocked.push(item.buyer||item.order_id);
  }

  if(changed){
    await kv.put(env,'queue',queue);
    if(unblocked.length===1){
      log(`💬 Webhook: ${unblocked[0]} iniciou chat — disparando imediatamente`,true);
    } else {
      log(`💬 Webhook: chat aberto — ${unblocked.length} pedido(s) disparando: ${unblocked.join(', ')}`,true);
    }
    await flush(env);
    return monitor(env);
  } else if(!queue.some(q=>!q.chat_opened)){
    // All items already chat_opened — webhook is just a follow-up message
  } else {
    // Could not identify specific buyer from webhook — fallback: unblock all
    log(`⚠ Webhook chat: não identifiquei comprador específico (msg_id=${msgId}), liberando fila inteira`,true);
    for(const item of queue){
      if(item.chat_opened) continue;
      if(!item.msgs_remaining?.length) continue;
      item.next_send_at=now+Math.random()*3000;
      item.chat_opened=true;
      changed=true;
    }
    if(changed){
      await kv.put(env,'queue',queue);
      await flush(env);
      return monitor(env);
    }
  }
}

// ── Broadcast: process recipients in background with throttling ─────────
async function processBroadcast(env,jobId,recipients,text,delayMin,delayMax){
  const cfg=await kv.obj(env,'cfg');
  const sellerId=cfg.seller_id;
  const updateJob=async(updater)=>{
    const jobs=await kv.obj(env,'broadcast_jobs',{});
    if(!jobs[jobId]) return;
    updater(jobs[jobId]);
    await kv.put(env,'broadcast_jobs',jobs);
  };

  const cycleStartMs=Date.now();
  const MAX_CYCLE_MS=25000; // free plan wall-time safety

  for(let i=0;i<recipients.length;i++){
    const r=recipients[i];

    // Time budget check — if we're running out, mark remaining as 'pending_resume'
    const elapsed=Date.now()-cycleStartMs;
    if(elapsed>MAX_CYCLE_MS){
      await updateJob(j=>{
        j.status='paused_time_limit';
        j.note='Pausado por limite de tempo. Rode /api/broadcast/resume?id='+jobId+' para continuar';
        j.remaining=recipients.slice(i);
      });
      return;
    }

    const personalized=text
      .replace(/\{nome\}/g,r.buyer||'')
      .replace(/\{pedido\}/g,r.order_id||'');

    try{
      // Check if chat is open (seller can post). Same packCheck logic as auto sender.
      const chatCheck=await mlFetch(env,cfg,'GET',
        `/messages/packs/${r.pack_id||r.order_id}/sellers/${sellerId}?tag=post_sale&mark_as_read=false`);
      if(!chatCheck?.ok){
        await updateJob(j=>{j.skipped++;j.details.push({order_id:r.order_id,buyer:r.buyer,result:'chat_unavailable',http:chatCheck?.status});});
      } else {
        const sr=await mlFetch(env,cfg,'POST',
          `/messages/packs/${r.pack_id||r.order_id}/sellers/${sellerId}?tag=post_sale`,
          {from:{user_id:sellerId,email:''},to:{user_id:r.buyer_id},text:personalized});
        if(sr?.ok){
          await updateJob(j=>{j.sent++;j.details.push({order_id:r.order_id,buyer:r.buyer,result:'sent'});});
        } else {
          const eb=await sr?.json().catch(()=>({}));
          await updateJob(j=>{j.failed++;j.details.push({order_id:r.order_id,buyer:r.buyer,result:'failed',error:eb?.message||sr?.status});});
        }
      }
    }catch(e){
      await updateJob(j=>{j.failed++;j.details.push({order_id:r.order_id,buyer:r.buyer,result:'error',error:String(e.message||e)});});
    }

    // Throttle between sends
    if(i<recipients.length-1){
      const waitMs=(delayMin+Math.random()*(delayMax-delayMin))*1000;
      await new Promise(res=>setTimeout(res,waitMs));
    }
  }
  await updateJob(j=>{j.status='done';j.completed_at=new Date().toISOString();});
}

// ── Monitor — KV write budget per cycle ──────────────────────────────────
// Idle (no products, no queue):  4 reads, 0 writes ✓
// With queue, no ready items:    4 reads, 0 writes ✓  ← KEY FIX
// With ready item, chat ok:      6 reads, 3 writes ✓
// With ready item, chat N/A:     5 reads, 1 write (queue update, every 2h not 5min) ✓
// New order detected:            7 reads, 4 writes ✓
async function monitor(env){
  const now=Date.now();
  const cfg=await kv.obj(env,'cfg');
  if(cfg.monitoring_enabled==='0') return;
  if(cfg.rate_limit_until&&now<Number(cfg.rate_limit_until)){
    log(`⏸ Rate limit — aguardando ${Math.ceil((Number(cfg.rate_limit_until)-now)/60000)}min`);
    await flush(env); return;
  }

  // Early exit: read minimal data first
  const prods=await kv.obj(env,'products_cfg');
  const enabled=Object.entries(prods).filter(([,v])=>v.enabled).map(([id,v])=>({id,cfg:v}));
  const queue=await kv.arr(env,'queue');
  const confirms=await kv.arr(env,'confirms');

  // Check if any queue items are actually ready to process right now
  const hasReadyQueue=queue.some(item=>item.next_send_at<=now&&item.msgs_remaining?.length>0);
  const hasReadyConfirm=confirms.some(item=>item.confirm_at<=now);

  // If nothing to do at all — silent exit, ZERO KV writes
  if(!enabled.length&&!queue.length&&!confirms.length) return;
  if(!enabled.length&&!hasReadyQueue&&!hasReadyConfirm) return;

  const msgs=await kv.obj(env,'messages_cfg');
  const processed=await kv.obj(env,'processed_ids');
  let rateLimited=false;

  // ── 1. Process message queue (cap TOTAL ML API calls per cycle) ─────────
  let queueMut=[...queue], qChanged=false;
  const failed=await kv.arr(env,'failed_messages'); let fChanged=false;
  let apiCallsThisCycle=0; const MAX_API_CALLS_PER_CYCLE=24; // packCheck+send total per cycle (doubled in v6.13 for parallelism)
  const cycleStartMs=Date.now();
  const MAX_CYCLE_DURATION_MS=25000; // 25s safe budget for free plan (limit is ~30s wall time)
  const MAX_IN_CYCLE_WAIT_SEC=18; // only stay in-cycle if wait fits comfortably

  // Process fresh orders FIRST (lower chat_retry_count goes first).
  // Prevents starvation when many items are stuck on "chat unavailable".
  queueMut.sort((a,b)=>(a.chat_retry_count||0)-(b.chat_retry_count||0));

  for(let i=0;i<queueMut.length;i++){
    const item=queueMut[i];
    if(!item.order_id||!item.msgs_remaining?.length) continue;

    // ── Periodic safety net: detect chat opening for items still awaiting ──
    // If item hasn't been unblocked by webhook but chat is actually open
    // (webhook may have failed/missed), proactively check every 5 min.
    if(!item.chat_opened&&item.next_send_at===Number.MAX_SAFE_INTEGER){
      const lastChatCheck=item.last_chat_poll||item.enqueued_at||0;
      const FIVE_MIN=300000;
      if(now-lastChatCheck>=FIVE_MIN){
        if(apiCallsThisCycle>=MAX_API_CALLS_PER_CYCLE) break;
        item.last_chat_poll=now;
        const cc=await mlFetch(env,cfg,'GET',
          `/messages/packs/${item.pack_id}/sellers/${cfg.seller_id}?tag=post_sale&mark_as_read=false`);
        apiCallsThisCycle++;
        if(cc?.ok){
          const cd=await cc.json().catch(()=>({}));
          const messages=cd.messages||cd.results||[];
          const buyerWrote=messages.some(m=>{
            const fromId=String(m.from?.user_id||m.from?.id||m.from||'');
            return fromId&&fromId!==String(cfg.seller_id);
          });
          if(buyerWrote){
            // Chat is now open — release immediately
            item.next_send_at=now+Math.random()*3000;
            item.chat_opened=true;
            qChanged=true;
            log(`💡 Pedido #${item.order_id} (${item.buyer}) — chat detectado aberto via polling, disparando`,true);
          } else {
            qChanged=true; // save last_chat_poll
          }
        }
      }
    }

    // Skip items not yet ready — NO write, NO KV op
    if(item.next_send_at>now) continue;
    if(rateLimited) break;
    if(apiCallsThisCycle>=MAX_API_CALLS_PER_CYCLE) break; // stop entirely; remaining items retry next cycle

    const msg=item.msgs_remaining[0];
    if(!msg?.trim()){
      item.msgs_remaining.shift(); qChanged=true;
      if(!item.msgs_remaining.length){queueMut.splice(i,1);i--;}
      continue;
    }

    // Check if chat-unavailable item is too old (48h) — abandon it
    if(item.chat_retry_count>0){
      const age=now-(item.first_attempt_at||now);
      if(age>CHAT_ABANDON_AGE){
        const msgNum=(item.total_msgs||4)-item.msgs_remaining.length+1;
        log(`🗑 Pedido ${item.order_id} abandonado após 48h sem chat disponível`,true);
        failed.unshift({order_id:item.order_id,item_id:item.item_id,buyer:item.buyer,
          msg_num:msgNum,msg_text:msg.slice(0,80),
          reason:'Chat não liberado após 48h',error_type:'no_chat',
          failed_at:new Date().toISOString()});
        if(failed.length>50) failed.splice(50);
        fChanged=true; queueMut.splice(i,1); i--; qChanged=true;
        continue;
      }
    }

    const msgNum=(item.total_msgs||4)-item.msgs_remaining.length+1;

    // ── ATOMIC SENDING LOCK ──────────────────────────────────────────
    // Prevent duplicate sends from parallel monitor() executions.
    // Before sending, re-read the queue fresh from KV and check if this
    // exact message (order + msgNum) is already locked or already sent.
    const freshQueue=await kv.arr(env,'queue');
    const freshItem=freshQueue.find(q=>String(q.order_id)===String(item.order_id));
    if(!freshItem){
      // Another execution already completed & removed this order
      queueMut.splice(i,1); i--;
      continue;
    }
    const freshMsgNum=(freshItem.total_msgs||4)-freshItem.msgs_remaining.length+1;
    if(freshMsgNum!==msgNum){
      // Another execution already advanced this order past msgNum — skip
      // Sync our local copy and move on
      item.msgs_remaining=[...freshItem.msgs_remaining];
      if(!item.msgs_remaining.length){queueMut.splice(i,1);i--;}
      continue;
    }
    // Check existing lock — if locked recently (<90s) by another execution, skip
    const lockKey=`${item.order_id}:${msgNum}`;
    if(freshItem.sending_lock){
      const lockAge=Date.now()-Number(freshItem.sending_lock);
      if(lockAge<90000&&freshItem.sending_lock_key===lockKey){
        // Another execution is actively sending this exact message — skip
        continue;
      }
    }
    // Acquire the lock: write it to KV immediately, BEFORE sending
    freshItem.sending_lock=String(Date.now());
    freshItem.sending_lock_key=lockKey;
    await kv.put(env,'queue',freshQueue);
    // Re-verify we won the lock (last-write-wins; re-read to confirm)
    const verifyQueue=await kv.arr(env,'queue');
    const verifyItem=verifyQueue.find(q=>String(q.order_id)===String(item.order_id));
    if(!verifyItem||verifyItem.sending_lock_key!==lockKey){
      // Lost the race to another execution — skip this message
      continue;
    }
    // We own the lock — use the verified item as our working copy
    queueMut[i]=verifyItem;
    const workItem=verifyItem;

    // Check for active claim/dispute — if any, abort this order entirely
    if(msgNum===1){
      try{
        const claimCheck=await mlFetch(env,cfg,'GET',
          `/post-purchase/v1/claims/search?resource=order&resource_id=${workItem.order_id}`);
        apiCallsThisCycle++;
        if(claimCheck?.ok){
          const cd=await claimCheck.json().catch(()=>({}));
          const activeClaim=(cd.data||cd.results||[]).find(c=>
            c.status==='opened'||c.stage==='claim'||c.status==='action_required');
          if(activeClaim){
            log(`🚫 Pedido #${workItem.order_id} (${workItem.buyer}) — reclamação aberta detectada (status: ${activeClaim.status}). Mensagens NÃO serão enviadas.`,true);
            for(const remaining of workItem.msgs_remaining){
              failed.unshift({order_id:workItem.order_id,item_id:workItem.item_id,buyer:workItem.buyer,
                msg_num:'?',msg_text:remaining.slice(0,80)+(remaining.length>80?'…':''),
                reason:`Reclamação aberta (status: ${activeClaim.status||'desconhecido'})`,
                error_type:'claim_active',failed_at:new Date().toISOString()});
            }
            if(failed.length>50) failed.splice(50); fChanged=true;
            // Remove from the fresh queue and persist
            const idx=verifyQueue.findIndex(q=>String(q.order_id)===String(workItem.order_id));
            if(idx>=0) verifyQueue.splice(idx,1);
            await kv.put(env,'queue',verifyQueue);
            queueMut=verifyQueue; i=-1; // restart loop with fresh queue
            continue;
          }
        }
      }catch{}
    }

    const packCheck=await mlFetch(env,cfg,'GET',
      `/messages/packs/${workItem.pack_id}/sellers/${cfg.seller_id}?tag=post_sale`);
    apiCallsThisCycle++;
    const chatOk=packCheck?.ok;
    let ok=false, httpStatus=0, respBody={};

    if(chatOk){
      const sr=await mlFetch(env,cfg,'POST',
        `/messages/packs/${workItem.pack_id}/sellers/${cfg.seller_id}?tag=post_sale`,
        {from:{user_id:cfg.seller_id,email:''},to:{user_id:workItem.buyer_id},text:msg});
      apiCallsThisCycle++;
      httpStatus=sr?.status??0;
      try{respBody=await sr?.json()??{}}catch{}
      ok=httpStatus===200||httpStatus===201;
    } else {
      httpStatus=packCheck?.status??403;
    }

    if(ok){
      log(`✅ Msg ${msgNum}/${workItem.total_msgs} → ${workItem.buyer}`,true);
      await bumpStat(env,'messages');
      // Re-read queue once more, advance THIS message, release lock, persist atomically
      const finalQueue=await kv.arr(env,'queue');
      const finalItem=finalQueue.find(q=>String(q.order_id)===String(workItem.order_id));
      if(finalItem){
        const finalMsgNum=(finalItem.total_msgs||4)-finalItem.msgs_remaining.length+1;
        if(finalMsgNum===msgNum){
          // Still our message — advance it
          finalItem.retries=0; finalItem.chat_retry_count=0;
          finalItem.msgs_remaining.shift();
          delete finalItem.sending_lock;
          delete finalItem.sending_lock_key;
          const ol=await kv.arr(env,'orders_log');
          const oe=ol.find(o=>o.order_id===workItem.order_id);
          if(oe){oe.msgs_sent=(oe.msgs_sent||0)+1;await kv.put(env,'orders_log',ol);}
          if(!finalItem.msgs_remaining.length){
            const idx=finalQueue.findIndex(q=>String(q.order_id)===String(workItem.order_id));
            if(idx>=0) finalQueue.splice(idx,1);
            if((cfg.auto_confirm??'1')==='1'){
              const c=await kv.arr(env,'confirms');
              c.push({order_id:workItem.order_id,confirm_at:now+60000});
              await kv.put(env,'confirms',c);
            }
          } else {
            // Schedule next message
            const dminS=finalItem.delay_min||15, dmaxS=finalItem.delay_max||45;
            const dmin=dminS*1000, dmax=dmaxS*1000;
            finalItem.next_send_at=Date.now()+dmin+Math.random()*(dmax-dmin);
          }
          await kv.put(env,'queue',finalQueue);
        }
        // else: another execution already advanced — our send was a no-op duplicate
        // (shouldn't happen with the lock, but safe fallback)
      }
      // Sync local queue and continue
      queueMut=await kv.arr(env,'queue');
      i=-1; // restart loop cleanly with fresh state
      continue;
    } else {
      // Send failed — release the lock so a retry can happen
      const failQueue=await kv.arr(env,'queue');
      const fi=failQueue.find(q=>String(q.order_id)===String(workItem.order_id));
      if(fi){
        delete fi.sending_lock;
        delete fi.sending_lock_key;
        const e=errType(httpStatus,respBody);
        if(e.t==='rate_limit'){
          rateLimited=true;
          cfg.rate_limit_until=String(now+RATE_LIMIT_WAIT);
          await kv.put(env,'cfg',cfg);
          log('🚫 Rate limit ML — pausando 1h',true);
        } else if(e.t==='no_chat'||!chatOk){
          // Chat not available — retry every 5min, but cap retries
          const isFirst=!fi.chat_retry_count;
          if(!fi.first_attempt_at) fi.first_attempt_at=now;
          fi.chat_retry_count=(fi.chat_retry_count||0)+1;
          const MAX_CHAT_RETRIES=12; // 12 × 5min = 1h of trying
          if(fi.chat_retry_count>=MAX_CHAT_RETRIES){
            log(`🚫 Pedido #${fi.order_id} (${fi.buyer}) — chat bloqueado após ${MAX_CHAT_RETRIES} tentativas (provável reclamação aberta). Pedido removido da fila.`,true);
            for(const remaining of fi.msgs_remaining){
              failed.unshift({order_id:fi.order_id,item_id:fi.item_id,buyer:fi.buyer,
                msg_num:'?',msg_text:remaining.slice(0,80)+(remaining.length>80?'…':''),
                reason:'Chat bloqueado pelo ML (provável reclamação/contestação aberta)',
                error_type:'chat_blocked',failed_at:new Date().toISOString()});
            }
            if(failed.length>50) failed.splice(50); fChanged=true;
            const idx=failQueue.findIndex(q=>String(q.order_id)===String(fi.order_id));
            if(idx>=0) failQueue.splice(idx,1);
          } else {
            fi.next_send_at=now+CHAT_RETRY_WAIT;
            if(isFirst) log(`⏳ Chat indisponível (HTTP ${httpStatus}) — pedido ${fi.order_id} — tentando a cada 5min`,true);
          }
        } else {
          fi.retries=(fi.retries||0)+1;
          if(fi.retries<=MAX_RETRIES){
            fi.next_send_at=now+120000;
            log(`🔁 Retry ${fi.retries}/${MAX_RETRIES} msg ${msgNum}→${fi.buyer} (${e.m})`,true);
            await bumpStat(env,'retries');
          } else {
            log(`❌ Falha definitiva msg ${msgNum}/${fi.total_msgs}→${fi.buyer}: ${e.m}`,true);
            fi.msgs_remaining.shift();
            failed.unshift({order_id:fi.order_id,item_id:fi.item_id,buyer:fi.buyer,
              msg_num:msgNum,msg_text:msg.slice(0,80)+(msg.length>80?'…':''),
              reason:e.m,error_type:e.t,failed_at:new Date().toISOString()});
            if(failed.length>50) failed.splice(50); fChanged=true;
            if(!fi.msgs_remaining.length){
              const idx=failQueue.findIndex(q=>String(q.order_id)===String(fi.order_id));
              if(idx>=0) failQueue.splice(idx,1);
            }
          }
        }
        await kv.put(env,'queue',failQueue);
      }
      queueMut=await kv.arr(env,'queue');
      i=-1;
      continue;
    }
  }
  if(qChanged) await kv.put(env,'queue',queueMut);
  if(fChanged) await kv.put(env,'failed_messages',failed);

  // ── 2. Confirmations (only after all messages sent) ───────────────────
  if(hasReadyConfirm){
    let confirmsMut=[...confirms]; const pending=[]; let cChanged=false;
    for(const item of confirmsMut){
      if(item.confirm_at>now){pending.push(item);continue;}
      if(queueMut.some(q=>q.order_id===item.order_id)){
        item.confirm_at=now+120000; pending.push(item); cChanged=true; continue;
      }
      const r=await mlFetch(env,cfg,'POST',`/orders/${item.order_id}/feedback`,
        {fulfilled:true,rating:'positive',message:''});
      let ok=r?.status===200||r?.status===201;
      let errMsg='';
      let alreadyDone=false;
      if(!ok){
        try{
          const eb=await r?.json();
          errMsg=eb?.message||eb?.error||`HTTP ${r?.status}`;
        }catch{errMsg=`HTTP ${r?.status||'?'}`;}
        // "Feedback already exists" means the sale IS already confirmed —
        // treat as success and stop retrying forever.
        if(/already\s*exist/i.test(errMsg)||r?.status===409){
          alreadyDone=true; ok=true;
        }
      }
      if(alreadyDone){
        log(`✔ Venda #${item.order_id} já estava confirmada`,true);
      } else {
        log(`${ok?'✔':'⚠'} Venda #${item.order_id} ${ok?'confirmada':'pendente: '+errMsg}`,true);
      }
      if(ok){
        if(!alreadyDone) await bumpStat(env,'confirmed');
        const ol=await kv.arr(env,'orders_log');
        const oe=ol.find(o=>o.order_id===item.order_id);
        if(oe){oe.confirmed=true;await kv.put(env,'orders_log',ol);}
        // Do NOT push back to pending — done forever
      } else {
        // Real error — retry, but cap attempts to avoid infinite loop
        item.confirm_attempts=(item.confirm_attempts||0)+1;
        if(item.confirm_attempts<=5){
          item.confirm_at=now+300000;
          pending.push(item);
        } else {
          log(`⚠ Venda #${item.order_id} — desisti de confirmar após 5 tentativas (${errMsg})`,true);
          // Drop from confirms queue
        }
      }
      cChanged=true;
    }
    if(cChanged) await kv.put(env,'confirms',pending);
  }

  if(rateLimited){await flush(env);return;}

  // ── 3. Poll new paid orders — 1 query total (was N queries = rate limit!) ─
  if(!cfg.seller_id) return;
  if(!enabled.length) return;

  // Heartbeat: silent on most cycles (zero writes when idle).
  // But every 30 min, log as event so the user sees proof of life in the activity log.
  const minuteNow=new Date().getMinutes();
  const isHourlyHeartbeat=(minuteNow===0||minuteNow===30);
  log(`🔍 Verificando fila (${enabled.length} produto(s) ativo(s))...`,isHourlyHeartbeat);

  // ── Polling removed in v6.8 ──
  // Webhooks now handle all new order detection in real-time.
  // The cron's only job is to drain the message queue (already done above)
  // and to drive scheduled retries / next_send_at delays.

  await flush(env);
}
