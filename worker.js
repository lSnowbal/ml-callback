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
  async obj(env,k,d={})  { countOp('reads'); try{return JSON.parse(await env.ML_STORE.get(k)||'null')??d}catch{return d} },
  async arr(env,k)        { countOp('reads'); try{return JSON.parse(await env.ML_STORE.get(k)||'[]')}catch{return []} },
  async put(env,k,v,ttl)  { countOp('writes'); await env.ML_STORE.put(k,JSON.stringify(v),ttl?{expirationTtl:ttl}:{}) },
  async del(env,k)        { countOp('deletes'); try{await env.ML_STORE.delete(k)}catch{} },
};

// ══ QUEUE STORAGE — ONE KV KEY PER ORDER (v6.23) ═══════════════════════
// The queue used to live in a single 'queue' key. Cloudflare KV is eventually
// consistent, so two concurrent read-modify-write cycles (a new order arriving
// while the monitor advances another order) could overwrite each other and
// SILENTLY DROP an order — exactly the "encavalamento" bug. One key per order
// makes that impossible: concurrent orders never touch the same key.
const QP='q:';
async function qGet(env,id){ return await kv.obj(env,QP+String(id),null); }
async function qPut(env,item){
  await kv.put(env,QP+String(item.order_id),item);
  await qIndexAdd(env,item.order_id); // só grava o índice quando o id é novo
}
async function qDel(env,id){
  await kv.del(env,QP+String(id));
  await qIndexRemove(env,id);
}
// Índice da fila. Fica FORA do prefixo q: para não aparecer nas varreduras.
// Ele é só um atalho: a verdade continua sendo uma chave por pedido, e uma
// varredura periódica conserta qualquer divergência.
const QIDX='queue_index';
async function qIndexGet(env){ return await kv.arr(env,QIDX); }
async function qIndexAdd(env,id){
  const idx=await qIndexGet(env);
  if(!idx.includes(String(id))){ idx.push(String(id)); await kv.put(env,QIDX,idx); }
}
async function qIndexRemove(env,id){
  const idx=await qIndexGet(env);
  const out=idx.filter(x=>String(x)!==String(id));
  if(out.length!==idx.length) await kv.put(env,QIDX,out);
}
// Lista a fila SEM operação de listagem: lê o índice e busca cada pedido.
// Leituras são baratas (100 mil/dia); listagens são o recurso escasso (1 mil/dia).
async function qList(env){
  const idx=await qIndexGet(env);
  if(!idx.length) return [];
  const out=[]; const missing=[];
  for(const id of idx){
    const v=await qGet(env,id);
    if(v&&v.order_id) out.push(v); else missing.push(id);
  }
  if(missing.length){ // limpa entradas órfãs do índice
    await kv.put(env,QIDX,idx.filter(x=>!missing.includes(x)));
  }
  return out;
}
// Varredura real por prefixo — cara. Só em manutenção, backup, troca de conta
// e no reparo periódico do índice.
async function qListScan(env){
  const out=[]; let cursor;
  for(let guard=0;guard<10;guard++){
    countOp('lists'); const r=await env.ML_STORE.list({prefix:QP,cursor});
    for(const k of (r.keys||[])){
      const v=await kv.obj(env,k.name,null);
      if(v&&v.order_id) out.push(v);
    }
    if(r.list_complete||!r.cursor) break;
    cursor=r.cursor;
  }
  return out;
}
// Reconstrói o índice a partir da verdade (as chaves por pedido).
async function qIndexRepair(env){
  const real=await qListScan(env);
  const ids=real.map(x=>String(x.order_id));
  const idx=await qIndexGet(env);
  const same=ids.length===idx.length&&ids.every(x=>idx.includes(x));
  if(!same){
    await kv.put(env,QIDX,ids);
    log(`🔧 Índice da fila corrigido (${idx.length} → ${ids.length})`,true);
  }
  return real;
}

async function qClear(env){
  let cursor,n=0;
  for(let guard=0;guard<10;guard++){
    countOp('lists'); const r=await env.ML_STORE.list({prefix:QP,cursor});
    for(const k of (r.keys||[])){ await kv.del(env,k.name); n++; }
    if(r.list_complete||!r.cursor) break;
    cursor=r.cursor;
  }
  await kv.put(env,'queue',[]);
  await kv.put(env,QIDX,[]);
  return n;
}
// Single-order mutation: read fresh → modify → write. Because each order owns
// its key, this can never clobber a different order.
// fn may return 'remove' to delete the order.
async function qMutate(env,id,fn){
  const it=await qGet(env,id);
  if(!it) return null;
  const r=fn(it);
  if(r==='remove'){ await qDel(env,id); return null; }
  await qPut(env,it);
  return it;
}
// ── Processed-order markers: ONE KEY PER ORDER, with 30-day TTL (v6.23) ──
// 'processed_ids' was a single ever-growing object with the same lost-update
// risk as the queue. A lost marker means an already-finished order gets
// ingested again → DUPLICATE messages to the buyer. Per-order keys remove that
// risk and expire on their own, so the store no longer grows forever.
const SEEN='seen:';
async function seenHas(env,id){
  if(await env.ML_STORE.get(SEEN+String(id))) return true;
  const legacy=await kv.obj(env,'processed_ids');   // backwards compatibility
  return !!legacy[id];
}
async function seenMark(env,id){ await kv.put(env,SEEN+String(id),Date.now(),2592000); }
async function seenClear(env,id){
  await kv.del(env,SEEN+String(id));
  const legacy=await kv.obj(env,'processed_ids');
  if(legacy[id]){ delete legacy[id]; await kv.put(env,'processed_ids',legacy); }
}

// ── SAFETY NET (v6.23): recover orders that were logged but never sent ──
// Belt-and-braces: even if an order is somehow lost (KV hiccup, crash mid-cycle,
// a bug we haven't found), this notices it and puts it back in the queue.
// An order qualifies when: 0 messages sent, older than 4 min, younger than 24 h,
// not currently queued and not already recorded as a failure.
async function reconcileLostOrders(env){
  const ol=await kv.arr(env,'orders_log');
  if(!ol.length) return 0;
  const now=Date.now();
  const idxIds=(await qIndexGet(env)).map(String);
  const prods=await kv.obj(env,'products_cfg');
  const msgs=await kv.obj(env,'messages_cfg');
  let failed=null; // lazily loaded only if a candidate shows up
  let restored=0;
  for(const o of ol.slice(0,25)){
    if(!o?.order_id||o.msgs_sent>0||o.confirmed) continue;
    const created=new Date(o.created_at||0).getTime()||0;
    const age=now-created;
    if(age<240000||age>86400000) continue;       // 4 min grace, ignore >24h
    if(idxIds.includes(String(o.order_id))) continue; // já está na fila
    if(await qGet(env,o.order_id)){ await qIndexAdd(env,o.order_id); continue; } // conserta índice
    if(failed===null) failed=await kv.arr(env,'failed_messages');
    if(failed.some(f=>String(f.order_id)===String(o.order_id))) continue;
    const pc=prods[o.item_id];
    if(!pc?.enabled) continue;                    // product no longer monitored
    const list=(msgs[o.item_id]||[]).filter(m=>m?.trim())
      .map(m=>m.replace(/\{nome\}/g,o.buyer||'')
                .replace(/\{key\}/g,pc.product_key||'')
                .replace(/\{pedido\}/g,o.order_id));
    if(!list.length) continue;
    await qPut(env,{
      order_id:o.order_id,item_id:o.item_id,pack_id:o.pack_id||o.order_id,
      buyer_id:o.buyer_id||'',buyer:o.buyer||'comprador',
      msgs_remaining:list,total_msgs:list.length,
      delay_min:pc.delay_min||15,delay_max:pc.delay_max||90,
      next_send_at:now+Math.random()*3000,chat_opened:true,
      retries:0,chat_retry_count:0,first_attempt_at:now,enqueued_at:now,recovered:true,
    });
    restored++;
    log(`🛟 Pedido #${o.order_id} (${o.buyer}) ficou sem mensagens — recolocado na fila`,true);
    await tgSend(env,`🛟 <b>Pedido recuperado</b>\n#${o.order_id} — ${o.buyer}\nEstava sem mensagens e voltou para a fila.`,{alert:'recovered'});
  }
  return restored;
}

// One-time migration from the legacy single-key array to per-order keys.
async function qMigrate(env){
  const legacy=await kv.arr(env,'queue');
  if(!legacy.length) return 0;
  for(const it of legacy){ if(it?.order_id) await qPut(env,it); }
  await kv.put(env,'queue',[]);
  log(`🔀 Migrados ${legacy.length} pedido(s) da fila antiga para o novo formato`,true);
  return legacy.length;
}

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
    if(p==='/ping') return json({ok:true,v:'6.27'},200,CORS);

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
          } else {
            const eb=await r.text().catch(()=>'');
            log(`❌ Falha ao renovar token (HTTP ${r.status})`,true);
            await tgSend(env,`🔴 <b>Falha ao renovar o token do Mercado Livre</b>\nHTTP ${r.status}\n${String(eb).slice(0,200)}\n\nSe persistir, refaça a autorização no painel.`,{alert:'token_fail'});
          }
        }catch(e){
          await tgSend(env,`🔴 <b>Erro ao renovar token</b>\n${String(e.message||e).slice(0,200)}`,{alert:'token_fail'});
        }
      }
      await monitor(env);
      try{ await watchdog(env); }catch{}
      try{ if(new Date().getUTCMinutes()===11) await flushOps(env); }catch{}
      try{ await weeklyBackup(env); }catch{}
    })());
  },
};


// ══ MEDIDOR DE CONSUMO KV ══════════════════════════════════════════════
// Estimativa própria, para você ver o gasto sem depender do e-mail da
// Cloudflare. Guarda contadores por dia e grava no máximo 1x por hora.
let _ops={reads:0,writes:0,lists:0,deletes:0};
function countOp(kind,n=1){ _ops[kind]=(_ops[kind]||0)+n; }
async function flushOps(env){
  if(!_ops.reads&&!_ops.writes&&!_ops.lists&&!_ops.deletes) return;
  const today=new Date().toISOString().slice(0,10);
  const u=await kv.obj(env,'kv_usage',{});
  if(u.day!==today){ u.day=today; u.reads=0; u.writes=0; u.lists=0; u.deletes=0; }
  u.reads=(u.reads||0)+_ops.reads;
  u.writes=(u.writes||0)+_ops.writes;
  u.lists=(u.lists||0)+_ops.lists;
  u.deletes=(u.deletes||0)+_ops.deletes;
  u.updated_at=Date.now();
  _ops={reads:0,writes:0,lists:0,deletes:0};
  await kv.put(env,'kv_usage',u);
}

// ══ WATCHDOG — pega falha silenciosa, que é o pior tipo ════════════════
// Roda no máximo 1x por hora e só escreve/avisa quando encontra problema.
async function watchdog(env){
  const cfg=await kv.obj(env,'cfg');
  const now=Date.now();
  if(now-Number(cfg.watchdog_last_run||0)<3600000) return; // 1x/hora
  cfg.watchdog_last_run=String(now);

  const alerts=[];
  const seen=(()=>{ try{ return JSON.parse(cfg.watchdog_seen||'{}'); }catch{ return {}; } })();
  const canWarn=(k)=>now-Number(seen[k]||0)>21600000; // no máximo 1 aviso a cada 6h
  const warn=(k,msg)=>{ if(canWarn(k)){ alerts.push(msg); seen[k]=now; } };

  // 1. Token sem renovar há muito tempo (expira em 6h)
  const lastRefresh=Number(cfg.last_refresh_at||0);
  if(cfg.refresh_token&&lastRefresh&&now-lastRefresh>6.5*3600000){
    warn('token',`🔴 Token não é renovado há ${Math.round((now-lastRefresh)/3600000)}h — envios podem falhar.`);
  }
  // 2. Monitoramento desligado
  if(cfg.monitoring_enabled==='0') warn('paused','⏸ O monitoramento está PAUSADO. Nenhuma mensagem será enviada.');
  // 3. Rate limit preso por muito tempo
  if(cfg.rate_limit_until&&now<Number(cfg.rate_limit_until)){
    const mins=Math.ceil((Number(cfg.rate_limit_until)-now)/60000);
    if(mins>45) warn('rate',`🚫 Rate limit ativo por mais ${mins} min.`);
  }
  // 4. Pedido preso na fila há mais de 2h
  const q=await qList(env);
  const stuck=q.filter(it=>it.msgs_remaining?.length&&now-Number(it.enqueued_at||now)>7200000);
  if(stuck.length) warn('stuck',`⏳ ${stuck.length} pedido(s) parado(s) na fila há mais de 2h. Ex.: #${stuck[0].order_id} (${stuck[0].buyer}).`);
  // 5. Estoque de chaves acabando
  const prods=await kv.obj(env,'products_cfg');
  // keysStats faz uma listagem por anúncio — com muitos produtos isso pesa.
  // Roda a cada 6h em vez de toda hora.
  const checkKeys=new Date().getUTCHours()%6===0;
  for(const [id,pc] of Object.entries(checkKeys?prods:{})){
    if(!pc.enabled||(pc.key_mode||'fixed')==='fixed') continue;
    const st=await keysStats(env,id);
    if(st.available<=(pc.key_low_threshold??3)){
      warn(`keys_${id}`,`🔑 Anúncio ${id}: restam ${st.available} chave(s).`);
    }
  }
  // 6. Agente de IA local offline com fila pendente
  const ai=await kv.obj(env,'ai_config',{});
  if(ai.enabled&&ai.provider==='local_agent'){
    const jobs=await kv.arr(env,'ai_jobs');
    const pend=jobs.filter(j=>j.status!=='done').length;
    const seenAgent=Number(cfg.agent_last_seen||0);
    if(pend&&(!seenAgent||now-seenAgent>600000)){
      warn('agent',`🤖 O agente de IA local está offline e há ${pend} pergunta(s) aguardando.`);
    }
  }

  cfg.watchdog_seen=JSON.stringify(seen);
  await kv.put(env,'cfg',cfg);
  if(alerts.length){
    log(`🐕 Watchdog: ${alerts.length} alerta(s)`,true);
    await tgSend(env,`🐕 <b>Verificação de saúde</b>\n\n${alerts.join('\n\n')}`,{alert:'watchdog'});
  }
}

// ══ BACKUP SEMANAL — enviado como arquivo para o seu Telegram ══════════
// Não ocupa KV, não entra no caminho crítico: roda 1x por semana e só faz
// leituras + um envio HTTP.
async function weeklyBackup(env){
  const tg=await kv.obj(env,'telegram_cfg',{});
  if(!tg.enabled||!tg.token||!tg.chat_id) return;
  const now=Date.now();
  if(now-Number(tg.last_backup||0)<7*86400000) return; // 1x por semana

  const data={};
  for(const k of ['cfg','products_cfg','messages_cfg','templates_lib','quick_replies',
                  'ai_config','telegram_cfg','accounts','orders_log','stats']){
    try{ const v=await env.ML_STORE.get(k); if(v!==null) data[k]=v; }catch{}
  }
  try{ data.queue=JSON.stringify(await qList(env)); }catch{}
  // nunca exporta segredos em texto claro
  try{
    const c=JSON.parse(data.cfg||'{}');
    ['access_token','refresh_token','client_secret','secret_key'].forEach(f=>{ if(c[f]) c[f]='***removido***'; });
    data.cfg=JSON.stringify(c);
  }catch{}
  try{
    const a=JSON.parse(data.ai_config||'{}'); if(a.api_key) a.api_key='***removido***';
    data.ai_config=JSON.stringify(a);
  }catch{}
  try{
    const t=JSON.parse(data.telegram_cfg||'{}'); if(t.token) t.token='***removido***';
    data.telegram_cfg=JSON.stringify(t);
  }catch{}

  const payload=JSON.stringify({exported_at:new Date().toISOString(),version:'6.27',data},null,1);
  const name=`ml-sender-backup-${new Date().toISOString().slice(0,10)}.json`;
  const ok=await tgSendDoc(env,name,payload,'📦 Backup semanal do ML Auto Sender (credenciais removidas por segurança).');
  if(ok){
    tg.last_backup=String(now);
    await kv.put(env,'telegram_cfg',tg);
    log('📦 Backup semanal enviado para o Telegram',true);
  }
}

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
  // ── Debug: raw visits data from ML for first few products ──
  if(p==='/api/debug/visits'&&m==='GET'){
    const days=Math.min(90,Math.max(1,parseInt(url.searchParams.get('days'))||30));
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'sem credenciais'},400,CORS);
    const prods=await listings(env);
    const sample=prods.slice(0,3).map(p=>p.id);
    const out={tested_ids:sample,attempts:[]};
    // Try several endpoint variants to see which works
    const variants=[
      `/items/visits/time_window?ids=${sample.join(',')}&last=${days}&unit=day`,
      `/items/visits?ids=${sample.join(',')}&date_from=${new Date(Date.now()-days*86400000).toISOString().slice(0,10)}&date_to=${new Date().toISOString().slice(0,10)}`,
    ];
    if(sample[0]){
      variants.push(`/items/${sample[0]}/visits/time_window?last=${days}&unit=day`);
    }
    for(const v of variants){
      try{
        const r=await mlFetch(env,cfg,'GET',v);
        let body=null;
        try{body=await r.json();}catch{body='(não-JSON)';}
        out.attempts.push({endpoint:v,status:r?.status,body});
      }catch(e){
        out.attempts.push({endpoint:v,error:String(e.message||e)});
      }
    }
    // Also show orders_log sample
    const ol=await kv.arr(env,'orders_log');
    out.orders_log_count=ol.length;
    out.orders_log_sample=ol.slice(0,5).map(o=>({order_id:o.order_id,item_id:o.item_id,created_at:o.created_at,confirmed:o.confirmed}));
    return json(out,200,CORS);
  }

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

  // Manually clear rate limit pause (use sparingly — ML may re-block if abused)
  if(p==='/api/rate_limit/clear'&&m==='POST'){
    const cfg=await kv.obj(env,'cfg');
    const wasActive=cfg.rate_limit_until&&Date.now()<Number(cfg.rate_limit_until);
    delete cfg.rate_limit_until;
    await kv.put(env,'cfg',cfg);
    log(`▶ Rate limit limpo manualmente`,true);
    return json({ok:true,was_active:wasActive},200,CORS);
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
    const seenNew=await env.ML_STORE.get(SEEN+String(orderId));
    const inQueue=await qGet(env,orderId);
    return json({
      ml_status:r.status,
      processed_at:seenNew?new Date(Number(seenNew)).toISOString()
                  :(processed[orderId]?new Date(processed[orderId]).toISOString():null),
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
    await seenClear(env,order_id);
    return json({ok:true,message:'pedido será reprocessado no próximo ciclo'},200,CORS);
  }

  // ── Force-unblock: release a specific stuck order (skip waiting for buyer msg) ──
  if(p==='/api/order/force_send'&&m==='POST'){
    const{order_id}=await req.json();
    if(!order_id) return json({error:'order_id obrigatório'},400,CORS);
    const updated=await qMutate(env,order_id,(it)=>{
      it.next_send_at=Date.now()+Math.random()*3000;
      it.chat_opened=true;
    });
    if(!updated) return json({error:'pedido não está na fila',hint:'use /api/order/retry para reprocessar'},404,CORS);
    // Fire monitor immediately
    monitor(env).catch(()=>{});
    return json({ok:true,message:'envio forçado, monitor disparado'},200,CORS);
  }

  // ── List all queue items (for UI to show pending orders) ──
  if(p==='/api/queue/list'&&m==='GET'){
    await qMigrate(env);
    const queue=await qList(env);
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
      is_template:!!q.is_template,
      recovered:!!q.recovered,
    })),200,CORS);
  }

  // ════════════ INBOX — conversas com compradores ════════════
  // GET /api/inbox/list — lista conversas recentes (dos pedidos no orders_log)
  if(p==='/api/inbox/list'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'sem credenciais'},400,CORS);
    const ol=await kv.arr(env,'orders_log');
    // Most recent 40 orders that have a pack_id
    const recent=ol.filter(o=>o.pack_id||o.order_id).slice(0,40);
    const inboxMeta=await kv.obj(env,'inbox_meta',{}); // {packId:{last_read_ts,...}}
    const convos=recent.map(o=>{
      const packId=String(o.pack_id||o.order_id);
      const meta=inboxMeta[packId]||{};
      return{
        pack_id:packId,
        order_id:o.order_id,
        buyer:o.buyer||'comprador',
        buyer_id:o.buyer_id||'',
        item_id:o.item_id||'',
        created_at:o.created_at,
        last_read_ts:meta.last_read_ts||0,
        last_msg_preview:meta.last_msg_preview||'',
        last_msg_ts:meta.last_msg_ts||0,
        unread:meta.unread||false,
      };
    });
    return json(convos,200,CORS);
  }

  // GET /api/inbox/thread?pack_id=X — histórico completo de uma conversa
  if(p==='/api/inbox/thread'&&m==='GET'){
    const packId=url.searchParams.get('pack_id');
    if(!packId) return json({error:'pack_id required'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'sem credenciais'},400,CORS);
    const r=await mlFetch(env,cfg,'GET',
      `/messages/packs/${packId}/sellers/${cfg.seller_id}?tag=post_sale&mark_as_read=true`);
    if(!r?.ok) return json({error:`erro ML HTTP ${r?.status}`},502,CORS);
    const data=await r.json().catch(()=>({}));
    const raw=data.messages||data.results||[];
    const messages=raw.map(mm=>{
      const fromId=String(mm.from?.user_id||mm.from?.id||mm.from||'');
      return{
        id:mm.id||'',
        from:fromId===String(cfg.seller_id)?'seller':'buyer',
        text:mm.text||mm.message||'',
        date:mm.message_date?.created||mm.date_created||mm.date||'',
      };
    }).sort((a,b)=>(a.date<b.date?-1:1));
    // Mark as read in our meta
    const inboxMeta=await kv.obj(env,'inbox_meta',{});
    const last=messages[messages.length-1];
    inboxMeta[packId]={
      ...(inboxMeta[packId]||{}),
      last_read_ts:Date.now(),
      unread:false,
      last_msg_preview:last?last.text.slice(0,60):'',
      last_msg_ts:last?new Date(last.date).getTime()||0:0,
    };
    await kv.put(env,'inbox_meta',inboxMeta);
    return json({
      messages,
      suggestion:(await kv.obj(env,'inbox_suggestions',{}))[packId]||null,
      quick_replies:await kv.arr(env,'quick_replies'),
    },200,CORS);
  }

  // POST /api/inbox/send — envia mensagem manual numa conversa
  if(p==='/api/inbox/send'&&m==='POST'){
    const{pack_id,buyer_id,text}=await req.json();
    if(!pack_id||!text?.trim()) return json({error:'pack_id e text obrigatórios'},400,CORS);
    const cfg=await kv.obj(env,'cfg');
    if(!cfg.access_token||!cfg.seller_id) return json({error:'sem credenciais'},400,CORS);
    const sr=await mlFetch(env,cfg,'POST',
      `/messages/packs/${pack_id}/sellers/${cfg.seller_id}?tag=post_sale`,
      {from:{user_id:cfg.seller_id,email:''},to:{user_id:buyer_id||''},text:text.trim()});
    const ok=sr?.status===200||sr?.status===201;
    if(!ok){
      let eb={}; try{eb=await sr.json();}catch{}
      return json({error:eb?.message||`HTTP ${sr?.status}`},502,CORS);
    }
    // Clear any pending suggestion for this conversation
    const sugg=await kv.obj(env,'inbox_suggestions',{});
    if(sugg[pack_id]){delete sugg[pack_id];await kv.put(env,'inbox_suggestions',sugg);}
    return json({ok:true},200,CORS);
  }

  // POST /api/inbox/send_template — enfileira um template numa conversa,
  // respeitando o mesmo fluxo de pausas do envio automático.
  if(p==='/api/inbox/send_template'&&m==='POST'){
    const{pack_id,buyer_id,buyer,order_id,item_id,template,messages,delay_min,delay_max}=await req.json();
    if(!pack_id) return json({error:'pack_id obrigatório'},400,CORS);
    let list=[];
    if(Array.isArray(messages)&&messages.length) list=messages;
    else if(template){
      const lib=await kv.obj(env,'templates_lib',{});
      list=lib[template]||[];
      if(!list.length) return json({error:`template "${template}" não encontrado ou vazio`},404,CORS);
    } else return json({error:'informe template ou messages'},400,CORS);

    const prods=await kv.obj(env,'products_cfg');
    const pc=prods[item_id]||{};
    const nome=buyer||'comprador';
    const finalMsgs=list.filter(mm=>mm?.trim())
      .map(mm=>mm.replace(/\{nome\}/g,nome)
                 .replace(/\{key\}/g,pc.product_key||'')
                 .replace(/\{pedido\}/g,order_id||''));
    if(!finalMsgs.length) return json({error:'template sem mensagens válidas'},400,CORS);

    // Own queue entry, distinct from the sale's own entry so both can coexist.
    const qid=`tpl_${pack_id}_${Date.now().toString(36)}`;
    const now=Date.now();
    await qPut(env,{
      order_id:qid,real_order_id:order_id||'',item_id:item_id||'',pack_id:String(pack_id),
      buyer_id:buyer_id||'',buyer:nome,
      msgs_remaining:finalMsgs,total_msgs:finalMsgs.length,
      delay_min:Number(delay_min)||pc.delay_min||45,
      delay_max:Number(delay_max)||pc.delay_max||120,
      next_send_at:now+Math.random()*3000,chat_opened:true,
      retries:0,chat_retry_count:0,first_attempt_at:now,enqueued_at:now,
      is_template:true,no_confirm:true,
    });
    log(`📋 Template enfileirado para ${nome} (${finalMsgs.length} msg) — enviando com pausas`,true);
    monitor(env).catch(()=>{});
    return json({ok:true,queued:finalMsgs.length,queue_id:qid},200,CORS);
  }

  // GET /api/inbox/suggestions — lista perguntas com sugestão de IA pendente
  if(p==='/api/inbox/suggestions'&&m==='GET'){
    const sugg=await kv.obj(env,'inbox_suggestions',{});
    const list=Object.entries(sugg).map(([packId,s])=>({pack_id:packId,...s}));
    list.sort((a,b)=>(b.created_at||0)-(a.created_at||0));
    return json(list,200,CORS);
  }

  // POST /api/inbox/suggestions/dismiss — descarta uma sugestão
  if(p==='/api/inbox/suggestions/dismiss'&&m==='POST'){
    const{pack_id}=await req.json();
    const sugg=await kv.obj(env,'inbox_suggestions',{});
    if(sugg[pack_id]){delete sugg[pack_id];await kv.put(env,'inbox_suggestions',sugg);}
    return json({ok:true},200,CORS);
  }

  // ── Respostas rápidas do inbox ──
  if(p==='/api/quick_replies'&&m==='GET'){
    const qr=await kv.arr(env,'quick_replies');
    return json(qr,200,CORS);
  }
  if(p==='/api/quick_replies'&&m==='POST'){
    const body=await req.json();
    const list=Array.isArray(body.items)?body.items
      .filter(x=>x&&String(x.label||'').trim()&&String(x.text||'').trim())
      .slice(0,30)
      .map(x=>({label:String(x.label).slice(0,40),text:String(x.text).slice(0,350)})):[];
    await kv.put(env,'quick_replies',list);
    return json({ok:true,count:list.length},200,CORS);
  }

  // ── Importação de produtos em massa (CSV processado no navegador) ──
  if(p==='/api/products/bulk_import'&&m==='POST'){
    const body=await req.json();
    const items=Array.isArray(body.items)?body.items:[];
    if(!items.length) return json({error:'nenhum item recebido'},400,CORS);
    const prods=await kv.obj(env,'products_cfg');
    const msgs=await kv.obj(env,'messages_cfg');
    let updated=0; const skipped=[];
    for(const it of items){
      const id=String(it.id||'').trim();
      if(!id){ continue; }
      if(!prods[id]){ skipped.push(id); continue; } // só atualiza anúncios existentes
      if(it.enabled!==undefined) prods[id].enabled=!!it.enabled;
      if(it.delay_min!==undefined&&!isNaN(Number(it.delay_min))) prods[id].delay_min=Math.max(0,Number(it.delay_min));
      if(it.delay_max!==undefined&&!isNaN(Number(it.delay_max))) prods[id].delay_max=Math.max(0,Number(it.delay_max));
      if(it.product_key!==undefined) prods[id].product_key=String(it.product_key);
      if(Array.isArray(it.messages)&&it.messages.length) msgs[id]=it.messages.map(x=>String(x));
      updated++;
    }
    await kv.put(env,'products_cfg',prods);
    await kv.put(env,'messages_cfg',msgs);
    log(`📥 Importação CSV: ${updated} anúncio(s) atualizado(s)`,true);
    return json({ok:true,updated,skipped:skipped.slice(0,20),skipped_count:skipped.length},200,CORS);
  }


  // Consumo estimado de operações KV do dia
  if(p==='/api/kv_usage'&&m==='GET'){
    const u=await kv.obj(env,'kv_usage',{});
    const today=new Date().toISOString().slice(0,10);
    const cur=(u.day===today)?u:{day:today,reads:0,writes:0,lists:0,deletes:0};
    return json({
      day:cur.day,
      reads:cur.reads||0, writes:cur.writes||0,
      lists:cur.lists||0, deletes:cur.deletes||0,
      limits:{reads:100000,writes:1000,lists:1000,deletes:1000},
      updated_at:cur.updated_at||null,
      note:'estimativa própria do Worker; a contagem oficial fica no painel da Cloudflare',
    },200,CORS);
  }

  // ══ TELEGRAM ══════════════════════════════════════════════════════
  if(p==='/api/telegram'&&m==='GET'){
    const tg=await kv.obj(env,'telegram_cfg',{});
    return json({
      enabled:!!tg.enabled,has_token:!!tg.token,chat_id:tg.chat_id||'',
      alerts:tg.alerts||{new_question:true,claim:true,token_fail:true,rate_limit:true,
                          recovered:true,key_low:true,watchdog:true,daily_summary:true},
      last_backup:tg.last_backup||null,
    },200,CORS);
  }
  if(p==='/api/telegram'&&m==='POST'){
    const body=await req.json();
    const tg=await kv.obj(env,'telegram_cfg',{});
    if(body.token) tg.token=String(body.token).trim();
    if(body.enabled!==undefined) tg.enabled=!!body.enabled;
    if(body.alerts&&typeof body.alerts==='object') tg.alerts={...(tg.alerts||{}),...body.alerts};
    if(body.clear){ tg.token=''; tg.chat_id=''; tg.enabled=false; }
    await kv.put(env,'telegram_cfg',tg);
    return json({ok:true},200,CORS);
  }
  // Descobre o chat_id sozinho: usuário manda /start no bot e clica em Conectar
  if(p==='/api/telegram/connect'&&m==='POST'){
    const body=await req.json().catch(()=>({}));
    const tg=await kv.obj(env,'telegram_cfg',{});
    const token=String(body.token||tg.token||'').trim();
    if(!token) return json({error:'informe o token do bot (peça ao @BotFather)'},400,CORS);
    let r;
    try{ r=await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`); }
    catch(e){ return json({error:'não consegui falar com o Telegram'},502,CORS); }
    const data=await r.json().catch(()=>({}));
    if(!data.ok) return json({error:`token inválido: ${data.description||'verifique com o @BotFather'}`},400,CORS);
    const upd=(data.result||[]).reverse();
    const found=upd.find(u=>u.message?.chat?.id);
    if(!found) return json({error:'abra seu bot no Telegram e envie /start, depois clique em Conectar de novo'},404,CORS);
    tg.token=token; tg.chat_id=String(found.message.chat.id); tg.enabled=true;
    if(!tg.alerts) tg.alerts={new_question:true,claim:true,token_fail:true,rate_limit:true,
                               recovered:true,key_low:true,watchdog:true,daily_summary:true};
    await kv.put(env,'telegram_cfg',tg);
    await tgSend(env,'✅ <b>ML Auto Sender conectado!</b>\nVocê vai receber alertas aqui.');
    return json({ok:true,chat_id:tg.chat_id,name:found.message.chat.first_name||''},200,CORS);
  }
  if(p==='/api/telegram/test'&&m==='POST'){
    const ok=await tgSend(env,'🔔 Teste do ML Auto Sender — está funcionando.');
    return json(ok?{ok:true}:{error:'não enviou — confira token e conexão'},ok?200:400,CORS);
  }

  // ══ CHAVES DE PRODUTO ═════════════════════════════════════════════
  if(p==='/api/keys'&&m==='GET'){
    const itemId=url.searchParams.get('item_id');
    if(!itemId) return json({error:'item_id obrigatório'},400,CORS);
    const prods=await kv.obj(env,'products_cfg');
    const pc=prods[itemId]||{};
    const all=await keysList(env,itemId);
    return json({
      item_id:itemId,
      mode:pc.key_mode||'fixed',
      product_key:pc.product_key||'',
      max_uses:pc.key_max_uses||0,
      max_days:pc.key_max_days||0,
      low_threshold:pc.key_low_threshold??3,
      stats:{
        total:all.length,
        available:all.filter(k=>k.status==='available').length,
        active:all.filter(k=>k.status==='active').length,
        used:all.filter(k=>k.status==='used').length,
      },
      keys:all.map(k=>({id:k.id,key:k.key,status:k.status,uses:k.uses||0,
        order_id:k.order_id||'',used_at:k.used_at||null,activated_at:k.activated_at||null})),
    },200,CORS);
  }
  if(p==='/api/keys/mode'&&m==='POST'){
    const{item_id,mode,max_uses,max_days,low_threshold,product_key}=await req.json();
    if(!item_id) return json({error:'item_id obrigatório'},400,CORS);
    const prods=await kv.obj(env,'products_cfg');
    if(!prods[item_id]) return json({error:'anúncio não configurado'},404,CORS);
    if(mode) prods[item_id].key_mode=['fixed','pool','rotate'].includes(mode)?mode:'fixed';
    if(max_uses!==undefined) prods[item_id].key_max_uses=Math.max(0,Number(max_uses)||0);
    if(max_days!==undefined) prods[item_id].key_max_days=Math.max(0,Number(max_days)||0);
    if(low_threshold!==undefined) prods[item_id].key_low_threshold=Math.max(0,Number(low_threshold)||0);
    if(product_key!==undefined) prods[item_id].product_key=String(product_key);
    await kv.put(env,'products_cfg',prods);
    return json({ok:true},200,CORS);
  }
  if(p==='/api/keys/add'&&m==='POST'){
    const{item_id,keys}=await req.json();
    if(!item_id||!Array.isArray(keys)) return json({error:'item_id e keys obrigatórios'},400,CORS);
    // remove duplicadas do que já existe
    const existing=new Set((await keysList(env,item_id)).map(k=>k.key));
    const fresh=keys.map(k=>String(k||'').trim()).filter(k=>k&&!existing.has(k));
    const dup=keys.length-fresh.length;
    const n=await keysAdd(env,item_id,fresh);
    log(`🔑 ${n} chave(s) adicionada(s) ao anúncio ${item_id}`,true);
    return json({ok:true,added:n,duplicates:dup},200,CORS);
  }
  if(p==='/api/keys/delete'&&m==='POST'){
    const{item_id,key_id,delete_used}=await req.json();
    if(!item_id) return json({error:'item_id obrigatório'},400,CORS);
    if(delete_used){
      const all=await keysList(env,item_id);
      let n=0;
      for(const k of all){ if(k.status==='used'){ await kv.del(env,k._kv); n++; } }
      return json({ok:true,deleted:n},200,CORS);
    }
    if(!key_id) return json({error:'key_id obrigatório'},400,CORS);
    await kv.del(env,`${PK}${item_id}:${key_id}`);
    return json({ok:true,deleted:1},200,CORS);
  }
  if(p==='/api/keys/summary'&&m==='GET'){
    const prods=await kv.obj(env,'products_cfg');
    const out=[];
    for(const [id,pc] of Object.entries(prods)){
      const mode=pc.key_mode||'fixed';
      if(mode==='fixed') continue;
      const st=await keysStats(env,id);
      out.push({item_id:id,mode,available:st.available,used:st.used,
        low:st.available<=(pc.key_low_threshold??3)});
    }
    return json(out,200,CORS);
  }

  // ══ AGENTE DE IA LOCAL ════════════════════════════════════════════
  // O PC do usuário busca trabalho aqui — nada exposto na internet.
  if(p==='/api/ai/jobs'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    // O agente consulta a cada 5s. Gravar o heartbeat sempre seria ~17 mil
    // escritas/dia e estouraria o limite sozinho — grava no máximo 1x a cada 5 min.
    if(Date.now()-Number(cfg.agent_last_seen||0)>300000){
      cfg.agent_last_seen=String(Date.now());
      await kv.put(env,'cfg',cfg);
    }
    const jobs=await kv.arr(env,'ai_jobs');
    const now=Date.now();
    let changed=false;
    // devolve para a fila jobs "presos" há mais de 5 min
    for(const j of jobs){
      if(j.status==='taken'&&now-Number(j.taken_at||0)>300000){ j.status='pending'; changed=true; }
    }
    const pending=jobs.filter(j=>j.status==='pending').slice(0,3);
    for(const j of pending){ j.status='taken'; j.taken_at=now; changed=true; }
    if(changed) await kv.put(env,'ai_jobs',jobs);
    return json({jobs:pending.map(j=>({id:j.id,question:j.question,prompt:j.prompt,history:j.history||[]}))},200,CORS);
  }
  if(p==='/api/ai/jobs/result'&&m==='POST'){
    const{job_id,mode,reply,reason}=await req.json();
    const jobs=await kv.arr(env,'ai_jobs');
    const job=jobs.find(j=>j.id===job_id);
    if(!job) return json({error:'job não encontrado'},404,CORS);
    job.status='done'; job.done_at=Date.now();
    await kv.put(env,'ai_jobs',jobs);
    const cfg=await kv.obj(env,'cfg');
    const ai=await kv.obj(env,'ai_config',{});
    const safeMode=['auto','suggest','skip'].includes(mode)?mode:'suggest';
    await applyAIResult(env,cfg,ai,job.pack_id,job.buyer_id,job.question,
      {mode:safeMode,reply:String(reply||'').slice(0,600),reason:String(reason||'').slice(0,200)});
    return json({ok:true},200,CORS);
  }
  if(p==='/api/ai/agent/status'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    const jobs=await kv.arr(env,'ai_jobs');
    const seen=Number(cfg.agent_last_seen||0);
    return json({
      last_seen:seen||null,
      online:seen?(Date.now()-seen<120000):false,
      pending:jobs.filter(j=>j.status==='pending').length,
      done_24h:jobs.filter(j=>j.status==='done'&&Date.now()-Number(j.done_at||0)<86400000).length,
    },200,CORS);
  }

  // ── AI config: knowledge base, rules, API key ──
  if(p==='/api/ai/config'&&m==='GET'){
    const ai=await kv.obj(env,'ai_config',{});
    return json({
      enabled:ai.enabled||false,
      auto_reply:ai.auto_reply||false,
      has_key:!!ai.api_key,
      rules:ai.rules||'',
      faq:ai.faq||[],
      provider:ai.provider||'openai',
      base_url:ai.base_url||'',
      model:ai.model||'',
      workers_ai_available:!!env.AI,
    },200,CORS);
  }
  if(p==='/api/ai/config'&&m==='POST'){
    const body=await req.json();
    const ai=await kv.obj(env,'ai_config',{});
    if(body.api_key!==undefined&&body.api_key!=='') ai.api_key=body.api_key;
    if(body.clear_key) ai.api_key='';
    if(body.enabled!==undefined) ai.enabled=!!body.enabled;
    if(body.auto_reply!==undefined) ai.auto_reply=!!body.auto_reply;
    if(body.rules!==undefined) ai.rules=String(body.rules).slice(0,3000);
    if(body.faq!==undefined) ai.faq=Array.isArray(body.faq)?body.faq.slice(0,50):[];
    if(body.model!==undefined) ai.model=body.model;
    if(body.provider!==undefined) ai.provider=body.provider;
    if(body.base_url!==undefined) ai.base_url=String(body.base_url||'').trim();
    await kv.put(env,'ai_config',ai);
    return json({ok:true},200,CORS);
  }
  // Test the AI key + a sample question
  if(p==='/api/ai/test'&&m==='POST'){
    const body=await req.json().catch(()=>({}));
    const saved=await kv.obj(env,'ai_config',{});
    // Permite testar sem salvar: campos enviados sobrepõem os salvos.
    const ai={...saved};
    if(body.provider) ai.provider=body.provider;
    if(body.base_url!==undefined) ai.base_url=body.base_url;
    if(body.model!==undefined) ai.model=body.model;
    if(body.api_key) ai.api_key=body.api_key;
    const prov=ai.provider||'openai';
    const needsKey=(prov==='openai'||prov==='anthropic');
    if(needsKey&&!ai.api_key) return json({error:'configure a chave de API primeiro'},400,CORS);
    if(prov==='openai_compat'&&!ai.base_url) return json({error:'informe a URL base do provedor'},400,CORS);
    if(prov==='workers_ai'&&!env.AI) return json({error:'binding "AI" não está configurado neste Worker (Settings → Bindings → Workers AI)'},400,CORS);
    const result=await askAI(ai,body.question||'Olá, consegue me enviar agora?',[],env);
    return json(result,200,CORS);
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
    const keys=['cfg','products_cfg','messages_cfg','templates_lib','orders_log','confirms','processed_ids','failed_messages','stats','broadcast_jobs','events'];
    const data={};
    for(const k of keys){
      try{
        const v=await env.ML_STORE.get(k); // FIX v6.23: was env.MLAS_KV (wrong binding → export always empty)
        if(v!==null) data[k]=v;
      }catch{}
    }
    try{ data.queue=JSON.stringify(await qListScan(env)); }catch{}
    // Redact secrets from the export (still useful as backup but safer)
    return json({
      exported_at:new Date().toISOString(),
      version:'6.27',
      data,
    },200,CORS);
  }

  // ── Restore: import a previously-exported JSON blob ──────────────────
  if(p==='/api/backup/import'&&m==='POST'){
    const body=await req.json();
    if(!body?.data) return json({error:'no data field'},400,CORS);
    let restored=0; const errors=[];
    for(const k in body.data){
      if(k==='queue') continue; // handled below (per-order keys)
      try{
        // FIX v6.23: was env.MLAS_KV (wrong binding) — every import silently failed
        await env.ML_STORE.put(k,body.data[k]);
        restored++;
      }catch(e){ errors.push(`${k}: ${String(e.message||e)}`); }
    }
    // Restore queue into per-order keys
    if(body.data.queue){
      try{
        await qClear(env);
        for(const it of JSON.parse(body.data.queue)){
          if(it?.order_id){ await qPut(env,it); restored++; }
        }
      }catch(e){ errors.push(`queue: ${String(e.message||e)}`); }
    }
    return json({ok:true,restored,errors:errors.length?errors:undefined},200,CORS);
  }

  // ── Health: comprehensive system status ──────────────────────────────
  if(p==='/api/health'&&m==='GET'){
    const cfg=await kv.obj(env,'cfg');
    const queue=await qList(env);
    const ol=await kv.arr(env,'orders_log');
    const lastRefresh=Number(cfg.last_refresh_at||0);
    const lastOrder=ol[0];
    const nextRefreshIn=lastRefresh?Math.max(0,5*60*60*1000-(Date.now()-lastRefresh)):0;
    return json({
      version:'6.27',
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
  // Per-account data: each account has its own products, messages, queue, etc.
  // On switch, current account's data is snapshotted, then target's is loaded.
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

    // Per-account data keys that get snapshotted/restored on switch.
    // NOTE: the queue is no longer a single key — it is handled separately
    // via qList/qClear because each order owns its own KV key (v6.23).
    const DATA_KEYS=['products_cfg','messages_cfg','confirms',
      'processed_ids','failed_messages','stats','orders_log','events','broadcast_jobs'];

    // 1. Snapshot CURRENT account's data into its namespace
    const currentId=cfg.active_account_id;
    if(currentId){
      const snapshot={};
      for(const k of DATA_KEYS){
        snapshot[k]=await env.ML_STORE.get(k); // raw string or null
      }
      snapshot.__queue_items=JSON.stringify(await qListScan(env));
      await kv.put(env,`accdata_${currentId}`,snapshot);
    }

    // 2. Load TARGET account's data from its namespace (if exists)
    const targetData=await kv.obj(env,`accdata_${id}`,null);
    for(const k of DATA_KEYS){
      if(targetData&&targetData[k]!=null){
        await env.ML_STORE.put(k,targetData[k]);
      } else {
        // No saved data for this key — start fresh
        await env.ML_STORE.put(k,k==='products_cfg'||k==='messages_cfg'||k==='stats'||k==='broadcast_jobs'?'{}':'[]');
      }
    }
    // Queue: wipe current account's order keys, restore target's
    await qClear(env);
    if(targetData&&targetData.__queue_items){
      try{
        for(const it of JSON.parse(targetData.__queue_items)){
          if(it?.order_id) await qPut(env,it);
        }
      }catch{}
    }

    // 3. Swap credentials
    cfg.access_token=acc.access_token||'';
    cfg.refresh_token=acc.refresh_token||'';
    cfg.seller_id=acc.seller_id||'';
    cfg.client_id=acc.client_id||'';
    cfg.client_secret=acc.client_secret||'';
    cfg.last_refresh_at=acc.last_refresh_at||'';
    cfg.active_account_id=id;
    await kv.put(env,'cfg',cfg);
    return json({ok:true,name:acc.name,seller_id:acc.seller_id,data_swapped:true},200,CORS);
  }
  if(p==='/api/accounts/delete'&&m==='POST'){
    const{id}=await req.json();
    const accounts=await kv.obj(env,'accounts',{});
    delete accounts[id];
    await kv.put(env,'accounts',accounts);
    // Also delete the account's data namespace
    try{await env.ML_STORE.delete(`accdata_${id}`);}catch{}
    return json({ok:true},200,CORS);
  }
  // Update credentials of an existing saved account (e.g. after re-auth)
  if(p==='/api/accounts/update_creds'&&m==='POST'){
    const{id}=await req.json();
    const accounts=await kv.obj(env,'accounts',{});
    if(!accounts[id]) return json({error:'account not found'},404,CORS);
    const cfg=await kv.obj(env,'cfg');
    accounts[id].access_token=cfg.access_token;
    accounts[id].refresh_token=cfg.refresh_token;
    accounts[id].last_refresh_at=cfg.last_refresh_at;
    await kv.put(env,'accounts',accounts);
    return json({ok:true},200,CORS);
  }

  // ── Clone listings: copy selected items from active account to a target account ──
  // POST { item_ids:[...], target_account_id, mode:'paused'|'active' }
  // Creates each item on the target account as a NEW listing (paused by default).
  if(p==='/api/listings/clone'&&m==='POST'){
    const{item_ids,target_account_id,mode}=await req.json();
    if(!Array.isArray(item_ids)||!item_ids.length) return json({error:'item_ids required'},400,CORS);
    if(!target_account_id) return json({error:'target_account_id required'},400,CORS);
    const accounts=await kv.obj(env,'accounts',{});
    const target=accounts[target_account_id];
    if(!target) return json({error:'conta destino não encontrada'},404,CORS);

    const srcCfg=await kv.obj(env,'cfg'); // current/source account
    if(!srcCfg.access_token) return json({error:'conta de origem sem token'},400,CORS);

    // Start a background clone job
    const jobId=`clone_${Date.now()}`;
    const job={
      id:jobId,created_at:new Date().toISOString(),
      total:item_ids.length,done:0,failed:0,
      status:'in_progress',
      target_name:target.name,
      mode:mode==='active'?'active':'paused',
      details:[],
    };
    const jobs=await kv.obj(env,'clone_jobs',{});
    jobs[jobId]=job;
    await kv.put(env,'clone_jobs',jobs);

    ctx.waitUntil(processCloneJob(env,jobId,item_ids,srcCfg,target,job.mode));
    return json({ok:true,job_id:jobId},200,CORS);
  }
  if(p==='/api/listings/clone/status'&&m==='GET'){
    const jobId=url.searchParams.get('id');
    const jobs=await kv.obj(env,'clone_jobs',{});
    if(jobId) return json(jobs[jobId]||{error:'not found'},jobs[jobId]?200:404,CORS);
    const list=Object.values(jobs).sort((a,b)=>b.created_at<a.created_at?-1:1).slice(0,10);
    return json(list,200,CORS);
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
    await qClear(env);
    await kv.put(env,'confirms',[]);
    return json({ok:true},200,CORS);
  }

  if(p==='/api/full/reset'&&m==='POST'){
    await kv.put(env,'stats',{orders:0,messages:0,confirmed:0,retries:0});
    await qClear(env);
    await kv.put(env,'confirms',[]);
    await kv.put(env,'processed_ids',{});
    // also wipe the per-order 'seen' markers so everything can be reprocessed
    try{
      let cursor;
      for(let g=0;g<10;g++){
        countOp('lists'); const r=await env.ML_STORE.list({prefix:SEEN,cursor});
        for(const k of (r.keys||[])) await kv.del(env,k.name);
        if(r.list_complete||!r.cursor) break;
        cursor=r.cursor;
      }
    }catch{}
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
  if(await seenHas(env,orderId)) return; // already handled by another execution
  await seenMark(env,orderId);

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
  // Resolve a chave desta venda (fixa, pool ou rotativa). A reserva acontece
  // AQUI, na entrada do pedido, e fica gravada no item da fila — assim um retry
  // reaproveita a mesma chave em vez de queimar outra.
  const keyRes=await reserveKey(env,itemId,pc,orderId);
  if(keyRes.empty){
    log(`🔑 SEM CHAVES para ${itemId} — pedido #${orderId} (${buyer}) não pode ser atendido automaticamente`,true);
    await tgSend(env,`🔑 <b>Acabaram as chaves</b>\nAnúncio ${itemId}\nPedido #${orderId} de ${buyer} ficou sem chave para enviar.`,{alert:'key_low'});
    const fl=await kv.arr(env,'failed_messages');
    fl.unshift({order_id:orderId,item_id:itemId,buyer,msg_num:'?',
      msg_text:'(sem chave disponível no estoque)',
      reason:'Estoque de chaves esgotado',error_type:'no_key',
      failed_at:new Date().toISOString()});
    if(fl.length>50) fl.splice(50);
    await kv.put(env,'failed_messages',fl);
    await pauseListingNoKeys(env,cfg,itemId,pc.title);
    await flush(env); return;
  }
  const saleKey=keyRes.key||'';
  // Aviso de estoque baixo (uma vez por limiar atingido)
  if(keyRes.remaining!==undefined){
    const limiar=pc.key_low_threshold??3;
    if(keyRes.remaining<=limiar){
      await tgSend(env,`🔑 <b>Estoque de chaves baixo</b>\nAnúncio ${itemId}: restam ${keyRes.remaining} chave(s).`,{alert:'key_low'});
      log(`🔑 Estoque baixo em ${itemId}: ${keyRes.remaining} chave(s) restante(s)`,true);
    }
    if(keyRes.remaining===0) await pauseListingNoKeys(env,cfg,itemId,pc.title);
  }

  const msgList=rawMsgs.filter(m=>m?.trim())
    .map(m=>m.replace(/\{nome\}/g,buyer)
              .replace(/\{key\}/g,saleKey)
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
      log(`⏭ ${source}: pedido #${orderId} (${buyer}) — você já enviou msg, ignorado`,true);
      await flush(env); return;
    }
  }

  if(msgList.length){
    // Decide whether to send immediately:
    // - chatAccessible: ML returned 200 on the pack → seller CAN post now
    // - send_on_chat_open setting (default ON): send as soon as chat is reachable
    // If chat not yet reachable, wait — periodic poll + webhook will unblock.
    const autoOnOpen=(cfg.send_on_chat_open??'1')==='1';
    const chatAlreadyOpen=chatAccessible&&(buyerAlreadyMessaged||autoOnOpen);
    // Own KV key → a concurrent order can never overwrite this one.
    if(await qGet(env,orderId)){
      log(`⏭ ${source}: pedido #${orderId} já está na fila, ignorado`,true);
      await flush(env); return;
    }
    await qPut(env,{
      order_id:orderId,item_id:itemId,pack_id:packId,
      buyer_id:buyerId,buyer,msgs_remaining:[...msgList],
      total_msgs:msgList.length,delay_min:pc.delay_min||15,
      delay_max:pc.delay_max||90,
      next_send_at:chatAlreadyOpen?(now+Math.random()*3000):Number.MAX_SAFE_INTEGER,
      chat_opened:chatAlreadyOpen,
      retries:0,chat_retry_count:0,first_attempt_at:now,
      enqueued_at:now,assigned_key:saleKey||undefined,
    });
    if(chatAlreadyOpen){
      log(`📦 ${source}: pedido #${orderId} | ${buyer} | chat disponível — enviando`,true);
      event('new_order',`Nova venda — ${buyer}`,`Pedido #${orderId} pronto pra enviar`);
    } else {
      log(`📦 ${source}: pedido #${orderId} | ${buyer} | aguardando chat ficar disponível`,true);
      event('new_order',`Nova venda — ${buyer}`,`Pedido #${orderId} aguardando chat`);
    }
  } else {
    log(`📦 ${source}: pedido #${orderId} sem mensagens configuradas`,true);
  }

  // Update orders log + stats
  const ol=await kv.arr(env,'orders_log');
  ol.unshift({order_id:orderId,item_id:itemId,buyer,buyer_id:buyerId,pack_id:packId,
    msgs_sent:0,confirmed:false,created_at:new Date().toISOString()});
  if(ol.length>100) ol.splice(100);
  await kv.put(env,'orders_log',ol);
  await bumpStat(env,'orders');
  await flush(env);
}

// Buyer sent a message — find any queue item from this buyer waiting for chat
// and release it (set next_send_at to now + small delay).
// ── Process a buyer message through the AI layer ──────────────────────
// Decides: auto-reply, store a suggestion for review, or skip.
async function processAIReply(env,cfg,packId,buyerId,questionText){
  const ai=await kv.obj(env,'ai_config',{});
  const prov=ai.provider||'openai';
  const noKeyNeeded=(prov==='workers_ai'||prov==='openai_compat'||prov==='local_agent');
  const ready=noKeyNeeded?true:!!ai.api_key;

  // Marca a conversa como não lida e avisa no Telegram (mesmo com a IA desligada)
  const inboxMeta=await kv.obj(env,'inbox_meta',{});
  inboxMeta[packId]={
    ...(inboxMeta[packId]||{}),
    unread:true,
    last_msg_preview:questionText.slice(0,60),
    last_msg_ts:Date.now(),
  };
  await kv.put(env,'inbox_meta',inboxMeta);
  await tgSend(env,`💬 <b>Pergunta de comprador</b>\n${questionText.slice(0,300)}`,{alert:'new_question'});

  if(!ai.enabled||!ready) return; // modo só inbox

  // Histórico curto para dar contexto
  let history=[];
  try{
    const r=await mlFetch(env,cfg,'GET',
      `/messages/packs/${packId}/sellers/${cfg.seller_id}?tag=post_sale&mark_as_read=false`);
    if(r?.ok){
      const data=await r.json().catch(()=>({}));
      const raw=data.messages||data.results||[];
      history=raw.map(mm=>{
        const fromId=String(mm.from?.user_id||mm.from?.id||mm.from||'');
        return{from:fromId===String(cfg.seller_id)?'seller':'buyer',text:mm.text||mm.message||''};
      });
    }
  }catch{}

  // IA local via agente: o Worker só publica a tarefa; o PC busca e responde.
  if(prov==='local_agent'){
    await aiEnqueueJob(env,{pack_id:packId,buyer_id:buyerId,question:questionText,
      history:history.slice(-6),prompt:buildAIPrompt(ai)});
    log(`🤖 Pergunta enviada para o agente local processar`,true);
    return;
  }

  const result=await askAI(ai,questionText,history,env);
  await applyAIResult(env,cfg,ai,packId,buyerId,questionText,result);
}

// Aplica o resultado da IA (venha de onde vier: nuvem ou agente local)
async function applyAIResult(env,cfg,ai,packId,buyerId,questionText,result){
  if(result.mode==='auto'&&ai.auto_reply&&result.reply){
    const sr=await mlFetch(env,cfg,'POST',
      `/messages/packs/${packId}/sellers/${cfg.seller_id}?tag=post_sale`,
      {from:{user_id:cfg.seller_id,email:''},to:{user_id:buyerId},text:result.reply});
    if(sr?.status===200||sr?.status===201){
      log(`🤖 IA respondeu automaticamente: "${questionText.slice(0,40)}…"`,true);
      const im=await kv.obj(env,'inbox_meta',{});
      im[packId]={...(im[packId]||{}),unread:false,ai_auto_replied:true};
      await kv.put(env,'inbox_meta',im);
      await bumpStat(env,'ai_auto');
      await tgSend(env,`🤖 <b>IA respondeu sozinha</b>\nPergunta: ${questionText.slice(0,120)}\nResposta: ${result.reply.slice(0,200)}`,{alert:'new_question'});
      return;
    }
  }
  const sugg=await kv.obj(env,'inbox_suggestions',{});
  sugg[packId]={
    buyer_id:buyerId,
    question:questionText.slice(0,400),
    suggested_reply:result.mode==='skip'?'':result.reply,
    mode:result.mode,
    reason:result.reason,
    created_at:Date.now(),
  };
  await kv.put(env,'inbox_suggestions',sugg);
  if(result.mode==='skip'){
    log(`🤖 IA: pergunta de comprador requer sua atenção (${result.reason})`,true);
  } else {
    log(`🤖 IA gerou sugestão de resposta — revise no Inbox`,true);
  }
}

// ══ TELEGRAM — alertas (bot próprio de cada usuário, custo zero) ═══════
async function tgSend(env,text,opts={}){
  const tg=await kv.obj(env,'telegram_cfg',{});
  if(!tg.enabled||!tg.token||!tg.chat_id) return false;
  if(opts.alert&&tg.alerts&&tg.alerts[opts.alert]===false) return false; // desligado
  try{
    const r=await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:tg.chat_id,text,parse_mode:'HTML',disable_web_page_preview:true}),
    });
    return r.ok;
  }catch{ return false; }
}
// Envia um arquivo (usado pelo backup semanal)
async function tgSendDoc(env,filename,content,caption){
  const tg=await kv.obj(env,'telegram_cfg',{});
  if(!tg.enabled||!tg.token||!tg.chat_id) return false;
  try{
    const fd=new FormData();
    fd.append('chat_id',String(tg.chat_id));
    if(caption) fd.append('caption',caption);
    fd.append('document',new Blob([content],{type:'application/json'}),filename);
    const r=await fetch(`https://api.telegram.org/bot${tg.token}/sendDocument`,{method:'POST',body:fd});
    return r.ok;
  }catch{ return false; }
}

// ══ CHAVES DE PRODUTO — pool com chave própria por registro ════════════
// Modos por anúncio:
//   fixed  → uma chave fixa (comportamento antigo, segue funcionando)
//   pool   → uma chave única por venda (padrão do mercado para licenças)
//   rotate → uma chave ativa vale por N dias e/ou N vendas, depois troca sozinha
// Cada chave é uma entrada KV própria (pk:<itemId>:<id>) — mesma lição da fila:
// lista única gera corrida e duas vendas poderiam receber a mesma chave.
const PK='pk:';
async function keysList(env,itemId){
  const out=[]; let cursor;
  for(let g=0;g<10;g++){
    countOp('lists'); const r=await env.ML_STORE.list({prefix:`${PK}${itemId}:`,cursor});
    for(const k of (r.keys||[])){
      const v=await kv.obj(env,k.name,null);
      if(v) out.push({...v,_kv:k.name});
    }
    if(r.list_complete||!r.cursor) break;
    cursor=r.cursor;
  }
  out.sort((a,b)=>(a.added_at||0)-(b.added_at||0));
  return out;
}
async function keysAdd(env,itemId,keys){
  let n=0;
  for(const raw of keys){
    const key=String(raw||'').trim();
    if(!key) continue;
    const id=`${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
    await kv.put(env,`${PK}${itemId}:${id}`,{id,key,status:'available',added_at:Date.now()});
    n++;
  }
  return n;
}
async function keysStats(env,itemId){
  const all=await keysList(env,itemId);
  return{
    total:all.length,
    available:all.filter(k=>k.status==='available').length,
    used:all.filter(k=>k.status==='used').length,
    active:all.find(k=>k.status==='active')||null,
  };
}
// Reserva a chave para um pedido. Reserva na ENTRADA do pedido, e a chave fica
// gravada no item da fila — assim retry não queima outra chave.
async function reserveKey(env,itemId,pc,orderId){
  const mode=pc.key_mode||'fixed';
  if(mode==='fixed') return{key:pc.product_key||'',mode};

  const all=await keysList(env,itemId);

  if(mode==='rotate'){
    const maxUses=Number(pc.key_max_uses||0);
    const maxDays=Number(pc.key_max_days||0);
    let active=all.find(k=>k.status==='active');
    const expired=(k)=>{
      if(!k) return true;
      if(maxUses&&Number(k.uses||0)>=maxUses) return true;
      if(maxDays&&Date.now()-Number(k.activated_at||0)>maxDays*86400000) return true;
      return false;
    };
    if(expired(active)){
      if(active){
        active.status='used'; active.retired_at=Date.now();
        await kv.put(env,active._kv,{...active,_kv:undefined});
      }
      const next=all.find(k=>k.status==='available');
      if(!next) return{key:null,mode,empty:true};
      next.status='active'; next.activated_at=Date.now(); next.uses=0;
      await kv.put(env,next._kv,{...next,_kv:undefined});
      active=next;
    }
    active.uses=Number(active.uses||0)+1;
    active.last_order=orderId;
    await kv.put(env,active._kv,{...active,_kv:undefined});
    const left=all.filter(k=>k.status==='available').length;
    return{key:active.key,mode,remaining:left};
  }

  // mode === 'pool': uma chave única por venda, com verificação anti-corrida
  const candidates=all.filter(k=>k.status==='available');
  for(const cand of candidates){
    cand.status='used'; cand.order_id=String(orderId); cand.used_at=Date.now();
    await kv.put(env,cand._kv,{...cand,_kv:undefined});
    const check=await kv.obj(env,cand._kv,null); // confirma que a chave é nossa
    if(check&&String(check.order_id)===String(orderId)){
      return{key:cand.key,mode,remaining:candidates.length-1};
    }
    // outra venda levou esta — tenta a próxima
  }
  return{key:null,mode,empty:true};
}
// Pausa o anúncio no ML quando o estoque de chaves acaba
async function pauseListingNoKeys(env,cfg,itemId,title){
  try{
    const r=await mlFetch(env,cfg,'PUT',`/items/${itemId}`,{status:'paused'});
    if(r?.ok){
      log(`⛔ Anúncio ${itemId} pausado: acabaram as chaves`,true);
      await tgSend(env,`⛔ <b>Anúncio pausado — sem chaves</b>\n${title||itemId}\n\nCadastre novas chaves e reative o anúncio.`,{alert:'key_low'});
      return true;
    }
  }catch{}
  return false;
}

// ══ AGENTE DE IA LOCAL — o PC busca trabalho, sem túnel nem porta aberta ══
async function aiEnqueueJob(env,job){
  const jobs=await kv.arr(env,'ai_jobs');
  jobs.unshift({...job,id:`job_${Date.now().toString(36)}`,status:'pending',created_at:Date.now()});
  if(jobs.length>50) jobs.splice(50);
  await kv.put(env,'ai_jobs',jobs);
}

// ── AI ENGINE — multi-provedor (v6.24) ────────────────────────────────
// Provedores suportados:
//   workers_ai    → Cloudflare Workers AI (binding env.AI, sem chave externa)
//   openai_compat → qualquer endpoint compatível com OpenAI: Ollama/LM Studio
//                   (local via túnel), DeepSeek, Qwen, Kimi, GLM, Groq…
//   openai        → OpenAI oficial
//   anthropic     → Claude (endpoint e cabeçalhos próprios)
function buildAIPrompt(ai){
  const faqText=(ai.faq||[]).map((f,i)=>`${i+1}. P: ${f.q}\n   R: ${f.a}`).join('\n')||'(nenhuma)';
  return `Você é um assistente de atendimento pós-venda de uma loja no Mercado Livre Brasil.
Responda perguntas de compradores de forma curta, cordial e em português brasileiro.

BASE DE CONHECIMENTO (perguntas frequentes e respostas oficiais da loja):
${faqText}

REGRAS DEFINIDAS PELO VENDEDOR:
${ai.rules||'(nenhuma regra adicional)'}

INSTRUÇÕES IMPORTANTES:
- Se a pergunta é coberta pela base de conhecimento ou é operacional simples, responda diretamente.
- Se envolve reclamação, defeito, devolução, reembolso, problema grave ou algo fora da base, NÃO invente — sinalize que precisa do vendedor.
- Nunca prometa nada que não esteja na base de conhecimento ou nas regras.
- Sua saída deve ser APENAS um objeto JSON, sem markdown, sem crases, sem texto antes ou depois:
{"mode":"auto","reply":"texto da resposta","reason":"motivo curto"}
- mode "auto": resposta segura e coberta pela base, pode enviar sozinho
- mode "suggest": gerou resposta mas o vendedor deve revisar antes
- mode "skip": não deve responder (reclamação/assunto sensível), só o vendedor`;
}

// Modelos pequenos (locais) frequentemente enfeitam o JSON. Extrai mesmo assim.
function parseAIJson(content){
  const raw=String(content||'').trim()
    .replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  let parsed=null;
  try{ parsed=JSON.parse(raw); }catch{
    const i=raw.indexOf('{'), j=raw.lastIndexOf('}');
    if(i>=0&&j>i){ try{ parsed=JSON.parse(raw.slice(i,j+1)); }catch{} }
  }
  if(!parsed||typeof parsed!=='object'){
    // Sem JSON válido: nunca envia sozinho, vira sugestão para revisão humana.
    return{mode:'suggest',reply:raw.slice(0,400),reason:'modelo não devolveu JSON válido'};
  }
  const mode=['auto','suggest','skip'].includes(parsed.mode)?parsed.mode:'suggest';
  return{
    mode,
    reply:String(parsed.reply||'').slice(0,600),
    reason:String(parsed.reason||'').slice(0,200),
  };
}

async function askAI(ai,question,history,env){
  const provider=ai.provider||'openai';
  const sys=buildAIPrompt(ai);
  const msgs=[];
  for(const h of (history||[]).slice(-6)){
    msgs.push({role:h.from==='seller'?'assistant':'user',content:h.text});
  }
  msgs.push({role:'user',content:question});
  const t0=Date.now();

  try{
    // ── Cloudflare Workers AI (roda na própria Cloudflare) ──
    if(provider==='workers_ai'){
      if(!env?.AI) return{mode:'skip',reply:'',reason:'binding "AI" não configurado no Worker (Settings → Bindings → Workers AI)'};
      const model=ai.model||'@cf/meta/llama-3.1-8b-instruct';
      const out=await env.AI.run(model,{
        messages:[{role:'system',content:sys},...msgs],
        max_tokens:400,temperature:0.3,
      });
      const content=out?.response||out?.result?.response||'';
      return{...parseAIJson(content),latency_ms:Date.now()-t0,provider,model};
    }

    // ── Claude (formato próprio: system separado, x-api-key) ──
    if(provider==='anthropic'){
      if(!ai.api_key) return{mode:'skip',reply:'',reason:'sem chave de API'};
      const model=ai.model||'claude-haiku-4-5-20251001';
      const r=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'x-api-key':ai.api_key,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
        body:JSON.stringify({model,max_tokens:400,temperature:0.3,system:sys,messages:msgs}),
      });
      if(!r.ok){
        let eb={}; try{eb=await r.json();}catch{}
        return{mode:'skip',reply:'',reason:`erro API: ${eb?.error?.message||r.status}`};
      }
      const data=await r.json();
      const content=(data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
      return{...parseAIJson(content),latency_ms:Date.now()-t0,provider,model};
    }

    // ── OpenAI e qualquer endpoint compatível (local, DeepSeek, Qwen, Groq…) ──
    let base=(provider==='openai')
      ? 'https://api.openai.com/v1'
      : String(ai.base_url||'').trim().replace(/\/+$/,'');
    if(!base) return{mode:'skip',reply:'',reason:'informe a URL base do provedor'};
    if(!/\/v\d+$/.test(base)&&!base.endsWith('/compatible-mode')&&!/\/paas\/v\d+$/.test(base)) base=base+'/v1';
    const model=ai.model||(provider==='openai'?'gpt-4o-mini':'llama3.1:8b');
    const headers={'Content-Type':'application/json'};
    if(ai.api_key) headers['Authorization']=`Bearer ${ai.api_key}`; // local costuma dispensar
    const payload={model,messages:[{role:'system',content:sys},...msgs],temperature:0.3,max_tokens:400};
    // response_format só é garantido na OpenAI; muitos compatíveis rejeitam.
    if(provider==='openai') payload.response_format={type:'json_object'};
    const r=await fetch(`${base}/chat/completions`,{method:'POST',headers,body:JSON.stringify(payload)});
    if(!r.ok){
      let eb={}; try{eb=await r.json();}catch{}
      return{mode:'skip',reply:'',reason:`erro API (${r.status}): ${eb?.error?.message||'ver URL/modelo/chave'}`};
    }
    const data=await r.json();
    const content=data.choices?.[0]?.message?.content||'';
    return{...parseAIJson(content),latency_ms:Date.now()-t0,provider,model};
  }catch(e){
    return{mode:'skip',reply:'',reason:`erro: ${String(e.message||e)} (se for IA local, confira se o túnel está acessível pela internet)`};
  }
}

async function unblockQueueOnBuyerMessage(env,payload){
  const queue=await qList(env);

  const cfg=await kv.obj(env,'cfg');
  if(!cfg.access_token||!cfg.seller_id) return;

  // The resource is like "/messages/MESSAGE_ID" — we need to fetch it
  // to discover which conversation (and thus which order/pack) it belongs to.
  const resource=payload.resource||'';
  const msgId=resource.split('/').filter(Boolean).pop();
  let targetPackId=null;
  let targetBuyerId=null;
  let buyerMsgText=''; // the actual question the buyer wrote

  if(msgId){
    try{
      const r=await mlFetch(env,cfg,'GET',`/messages/${msgId}`);
      if(r?.ok){
        const m=await r.json();
        // Extract pack_id from message metadata (location varies in ML responses)
        targetPackId=String(m.message_resources?.[0]?.id||m.resource_id||m.pack_id||'');
        targetBuyerId=String(m.from?.user_id||m.from?.id||'');
        buyerMsgText=String(m.text||m.message||'');
        // Only treat as buyer message if sender is NOT the seller
        if(targetBuyerId===String(cfg.seller_id)) buyerMsgText='';
      }
    }catch{}
  }

  // ── AI processing: if a buyer asked something, let the AI handle it ──
  if(buyerMsgText.trim()&&targetPackId){
    try{ await processAIReply(env,cfg,targetPackId,targetBuyerId,buyerMsgText); }
    catch(e){ /* AI failure must not break queue unblocking */ }
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
    // Per-order key write: cannot clobber other orders.
    await qMutate(env,item.order_id,(it)=>{
      it.next_send_at=now+Math.random()*3000;
      it.chat_opened=true;
    });
    changed=true;
    unblocked.push(item.buyer||item.order_id);
  }

  if(changed){
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
      await qMutate(env,item.order_id,(it)=>{
        it.next_send_at=now+Math.random()*3000;
        it.chat_opened=true;
      });
      changed=true;
    }
    if(changed){
      await flush(env);
      return monitor(env);
    }
  }
}

// ── Broadcast: process recipients in background with throttling ─────────
// ── Clone listings to another account (background job) ─────────────────
async function processCloneJob(env,jobId,itemIds,srcCfg,target,mode){
  const updateJob=async(updater)=>{
    const jobs=await kv.obj(env,'clone_jobs',{});
    if(!jobs[jobId]) return;
    updater(jobs[jobId]);
    await kv.put(env,'clone_jobs',jobs);
  };

  const mlCall=async(token,method,path,body)=>{
    const opts={method,headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}};
    if(body) opts.body=JSON.stringify(body);
    const r=await fetch(`https://api.mercadolibre.com${path}`,opts);
    let data=null; try{data=await r.json();}catch{}
    return{ok:r.ok,status:r.status,data};
  };

  for(let i=0;i<itemIds.length;i++){
    const itemId=itemIds[i];
    try{
      const src=await mlCall(srcCfg.access_token,'GET',`/items/${itemId}`);
      if(!src.ok){
        await updateJob(j=>{j.failed++;j.details.push({item_id:itemId,result:'erro',error:`buscar origem: HTTP ${src.status}`});});
        continue;
      }
      const it=src.data;
      const newItem={
        title:it.title,
        category_id:it.category_id,
        price:it.price,
        currency_id:it.currency_id||'BRL',
        available_quantity:it.available_quantity||1,
        buying_mode:it.buying_mode||'buy_it_now',
        listing_type_id:it.listing_type_id||'gold_special',
        condition:it.condition||'new',
        description:{plain_text:''},
        pictures:(it.pictures||[]).map(p=>({source:p.url||p.secure_url})),
        attributes:(it.attributes||[])
          .filter(a=>a.id&&a.value_name&&!['SELLER_SKU'].includes(a.id))
          .map(a=>({id:a.id,value_name:a.value_name})),
        status:mode==='active'?'active':'paused',
      };
      if(it.shipping){
        newItem.shipping={
          mode:it.shipping.mode,
          local_pick_up:it.shipping.local_pick_up,
          free_shipping:it.shipping.free_shipping,
        };
      }
      if(it.video_id) newItem.video_id=it.video_id;
      if(it.sale_terms) newItem.sale_terms=it.sale_terms;
      try{
        const desc=await mlCall(srcCfg.access_token,'GET',`/items/${itemId}/description`);
        if(desc.ok&&desc.data) newItem.description={plain_text:desc.data.plain_text||''};
      }catch{}
      const created=await mlCall(target.access_token,'POST','/items',newItem);
      if(!created.ok){
        const errMsg=created.data?.message||created.data?.cause?.[0]?.message||`HTTP ${created.status}`;
        await updateJob(j=>{j.failed++;j.details.push({item_id:itemId,title:it.title,result:'erro',error:errMsg});});
        continue;
      }
      await updateJob(j=>{j.done++;j.details.push({item_id:itemId,title:it.title,result:'clonado',new_id:created.data.id});});
    }catch(e){
      await updateJob(j=>{j.failed++;j.details.push({item_id:itemId,result:'erro',error:String(e.message||e)});});
    }
    if(i<itemIds.length-1) await new Promise(res=>setTimeout(res,1500));
  }
  await updateJob(j=>{j.status='done';j.completed_at=new Date().toISOString();});
}

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

  const isRateLimited=cfg.rate_limit_until&&now<Number(cfg.rate_limit_until);

  // Early exit: read minimal data first
  const prods=await kv.obj(env,'products_cfg');
  const enabled=Object.entries(prods).filter(([,v])=>v.enabled).map(([id,v])=>({id,cfg:v}));
  // Operações de listagem são o recurso escasso do plano gratuito (1.000/dia,
  // contra 100.000 leituras). Por isso o ciclo de 1 minuto NÃO lista nada:
  // usa o índice. As tarefas caras rodam em janelas espaçadas do relógio.
  const minute=new Date().getUTCMinutes();
  if(minute===3) await qMigrate(env);            // 1x por hora
  if(minute===7) await qIndexRepair(env);        // 1x por hora: corrige o índice
  if(minute%5===0) await reconcileLostOrders(env); // a cada 5 min
  const queue=await qList(env);
  const confirms=await kv.arr(env,'confirms');

  // Check if any queue items are actually ready to process right now
  const hasReadyQueue=queue.some(item=>item.next_send_at<=now&&item.msgs_remaining?.length>0);
  const hasReadyConfirm=confirms.some(item=>item.confirm_at<=now);

  // If rate limited: skip message queue but still allow confirmations
  // (confirmations use /orders/X/feedback endpoint, separate from message rate limit)
  if(isRateLimited){
    if(!hasReadyConfirm){
      // Nothing useful to do — log once at top of hour, then silent
      const mins=Math.ceil((Number(cfg.rate_limit_until)-now)/60000);
      if(mins%15===0) log(`⏸ Rate limit — aguardando ${mins}min`);
      await flush(env); return;
    }
    log(`⏸ Rate limit ativo, mas processando confirmações pendentes`,true);
  }

  // If nothing to do at all — silent exit, ZERO KV writes
  if(!enabled.length&&!queue.length&&!confirms.length) return;
  if(!enabled.length&&!hasReadyQueue&&!hasReadyConfirm) return;

  const msgs=await kv.obj(env,'messages_cfg');
  let rateLimited=isRateLimited; // start as already limited if so

  // ── 1. Process message queue ────────────────────────────────────────────
  // SAFE DESIGN (v6.19): never hold a stale full-queue copy across writes.
  // Every queue mutation = read fresh → modify ONLY the target order → write.
  // This guarantees orders enqueued concurrently are never overwritten/lost.
  const failed=await kv.arr(env,'failed_messages'); let fChanged=false;
  let apiCallsThisCycle=0; const MAX_API_CALLS_PER_CYCLE=24;
  const cycleStartMs=Date.now();
  const MAX_CYCLE_DURATION_MS=25000;

  // Mutate ONE order, in its own KV key. Other orders are never touched,
  // so a concurrent ingest/monitor can no longer erase them.
  async function mutateOrder(orderId,mutateFn){
    return await qMutate(env,orderId,mutateFn);
  }

  // Snapshot the order IDs ready to process this cycle.
  // We iterate over IDs (stable), re-reading each order fresh when we touch it.
  const snapshot=[...queue].sort((a,b)=>(a.chat_retry_count||0)-(b.chat_retry_count||0));
  const readyIds=snapshot
    .filter(it=>it.order_id&&it.msgs_remaining?.length>0&&(it.next_send_at||0)<=now)
    .map(it=>String(it.order_id));

  // Also handle periodic chat-open polling for items still awaiting buyer
  const awaitingIds=snapshot
    .filter(it=>it.order_id&&!it.chat_opened&&it.msgs_remaining?.length>0)
    .map(it=>String(it.order_id));

  // ── 1a. Periodic chat-open detection for awaiting items ──
  for(const orderId of awaitingIds){
    if(apiCallsThisCycle>=MAX_API_CALLS_PER_CYCLE) break;
    if(Date.now()-cycleStartMs>MAX_CYCLE_DURATION_MS) break;
    const item=await qGet(env,orderId);
    if(!item||item.chat_opened||!item.msgs_remaining?.length) continue;
    const lastPoll=item.last_chat_poll||item.enqueued_at||0;
    if(Date.now()-lastPoll<300000) continue; // poll every 5 min
    const cc=await mlFetch(env,cfg,'GET',
      `/messages/packs/${item.pack_id}/sellers/${cfg.seller_id}?tag=post_sale&mark_as_read=false`);
    apiCallsThisCycle++;
    let buyerWrote=false, chatReachable=false;
    if(cc?.ok){
      chatReachable=true;
      const cd=await cc.json().catch(()=>({}));
      const messages=cd.messages||cd.results||[];
      buyerWrote=messages.some(mm=>{
        const fromId=String(mm.from?.user_id||mm.from?.id||mm.from||'');
        return fromId&&fromId!==String(cfg.seller_id);
      });
    }
    await mutateOrder(orderId,(it)=>{
      if(!it) return;
      it.last_chat_poll=Date.now();
      // Release if buyer wrote OR (chat reachable AND auto-send-on-open enabled)
      const autoOnOpen=(cfg.send_on_chat_open??'1')==='1';
      if(buyerWrote||(chatReachable&&autoOnOpen)){
        it.next_send_at=Date.now()+Math.random()*3000;
        it.chat_opened=true;
      }
    });
    if(buyerWrote||chatReachable){
      log(`💡 Pedido #${orderId} — chat detectado disponível, liberado para envio`,true);
      if(!readyIds.includes(orderId)) readyIds.push(orderId);
    }
  }

  // ── 1b. Send messages for ready orders ──
  for(const orderId of readyIds){
    if(rateLimited) break;
    if(apiCallsThisCycle>=MAX_API_CALLS_PER_CYCLE) break;
    if(Date.now()-cycleStartMs>MAX_CYCLE_DURATION_MS) break;

    // Process all messages of this order that fit in the cycle budget
    let keepSending=true;
    while(keepSending){
      keepSending=false;
      if(rateLimited) break;
      if(apiCallsThisCycle>=MAX_API_CALLS_PER_CYCLE) break;
      if(Date.now()-cycleStartMs>MAX_CYCLE_DURATION_MS) break;

      // Read fresh state of THIS order
      const item=await qGet(env,orderId);
      if(!item||!item.msgs_remaining?.length) break; // done or removed
      if((item.next_send_at||0)>Date.now()) break;   // not ready yet

      const msg=item.msgs_remaining[0];
      if(!msg?.trim()){
        await mutateOrder(orderId,(it)=>{
          if(!it) return;
          it.msgs_remaining.shift();
          return it.msgs_remaining.length?undefined:'remove';
        });
        keepSending=true; continue;
      }

      const msgNum=(item.total_msgs||4)-item.msgs_remaining.length+1;

      // Abandon if chat-unavailable for 48h
      if(item.chat_retry_count>0&&now-(item.first_attempt_at||now)>CHAT_ABANDON_AGE){
        log(`🗑 Pedido ${orderId} abandonado após 48h sem chat disponível`,true);
        failed.unshift({order_id:orderId,item_id:item.item_id,buyer:item.buyer,
          msg_num:msgNum,msg_text:msg.slice(0,80),
          reason:'Chat não liberado após 48h',error_type:'no_chat',
          failed_at:new Date().toISOString()});
        if(failed.length>50) failed.splice(50); fChanged=true;
        await mutateOrder(orderId,()=>'remove');
        break;
      }

      // ── Atomic sending lock ──
      const lockKey=`${orderId}:${msgNum}`;
      if(item.sending_lock){
        const lockAge=Date.now()-Number(item.sending_lock);
        if(lockAge<90000&&item.sending_lock_key===lockKey) break; // another exec sending
      }
      // Acquire lock
      let lockWon=false;
      await mutateOrder(orderId,(it)=>{
        if(!it) return;
        it.sending_lock=String(Date.now());
        it.sending_lock_key=lockKey;
        lockWon=true;
      });
      if(!lockWon) break;
      // Verify lock
      const vItem=await qGet(env,orderId);
      if(!vItem||vItem.sending_lock_key!==lockKey) break; // lost race

      // Claim check on first message (skip for manual template sends)
      if(msgNum===1&&!vItem.is_template){
        try{
          const claimCheck=await mlFetch(env,cfg,'GET',
            `/post-purchase/v1/claims/search?resource=order&resource_id=${orderId}`);
          apiCallsThisCycle++;
          if(claimCheck?.ok){
            const cd=await claimCheck.json().catch(()=>({}));
            const activeClaim=(cd.data||cd.results||[]).find(c=>
              c.status==='opened'||c.stage==='claim'||c.status==='action_required');
            if(activeClaim){
              log(`🚫 Pedido #${orderId} (${vItem.buyer}) — reclamação aberta (${activeClaim.status}). Não enviando.`,true);
              await tgSend(env,`⚠️ <b>Reclamação aberta</b>\nPedido #${orderId} — ${vItem.buyer}\nAs mensagens automáticas foram bloqueadas.`,{alert:'claim'});
              for(const rem of vItem.msgs_remaining){
                failed.unshift({order_id:orderId,item_id:vItem.item_id,buyer:vItem.buyer,
                  msg_num:'?',msg_text:rem.slice(0,80),
                  reason:`Reclamação aberta (status: ${activeClaim.status||'?'})`,
                  error_type:'claim_active',failed_at:new Date().toISOString()});
              }
              if(failed.length>50) failed.splice(50); fChanged=true;
              await mutateOrder(orderId,()=>'remove');
              break;
            }
          }
        }catch{}
      }

      // Send
      const packCheck=await mlFetch(env,cfg,'GET',
        `/messages/packs/${vItem.pack_id}/sellers/${cfg.seller_id}?tag=post_sale`);
      apiCallsThisCycle++;
      const chatOk=packCheck?.ok;
      let ok=false, httpStatus=0, respBody={};
      if(chatOk){
        const sr=await mlFetch(env,cfg,'POST',
          `/messages/packs/${vItem.pack_id}/sellers/${cfg.seller_id}?tag=post_sale`,
          {from:{user_id:cfg.seller_id,email:''},to:{user_id:vItem.buyer_id},text:msg});
        apiCallsThisCycle++;
        httpStatus=sr?.status??0;
        try{respBody=await sr?.json()??{}}catch{}
        ok=httpStatus===200||httpStatus===201;
      } else {
        httpStatus=packCheck?.status??403;
      }

      if(ok){
        log(`✅ Msg ${msgNum}/${vItem.total_msgs} → ${vItem.buyer}`,true);
        await bumpStat(env,'messages');
        if(cfg.rate_limit_strikes){ delete cfg.rate_limit_strikes; await kv.put(env,'cfg',cfg); }
        let orderDone=false, nextDelay=0;
        await mutateOrder(orderId,(it)=>{
          if(!it) return;
          const curMsgNum=(it.total_msgs||4)-it.msgs_remaining.length+1;
          if(curMsgNum!==msgNum) return; // already advanced by another exec
          it.retries=0; it.chat_retry_count=0;
          it.msgs_remaining.shift();
          delete it.sending_lock; delete it.sending_lock_key;
          if(!it.msgs_remaining.length){orderDone=true;return 'remove';}
          const dminS=it.delay_min||15, dmaxS=it.delay_max||45;
          nextDelay=(dminS+Math.random()*(dmaxS-dminS))*1000;
          it.next_send_at=Date.now()+nextDelay;
        });
        // orders_log update
        const ol=await kv.arr(env,'orders_log');
        const oe=ol.find(o=>o.order_id===orderId);
        if(oe){
          oe.msgs_sent=(oe.msgs_sent||0)+1;
          if(msgNum===1){
            // tempo real entre a venda entrar na fila e a 1ª mensagem sair
            const enq=Number(vItem.enqueued_at||0);
            if(enq) oe.first_msg_ms=Math.max(0,Date.now()-enq);
          }
          await kv.put(env,'orders_log',ol);
        }
        if(orderDone){
          if((cfg.auto_confirm??'1')==='1'&&!vItem.no_confirm){
            const c=await kv.arr(env,'confirms');
            c.push({order_id:orderId,confirm_at:Date.now()+60000});
            await kv.put(env,'confirms',c);
          }
        } else {
          // In-cycle wait for short delays, else next cron picks it up
          const waitSec=nextDelay/1000;
          const elapsed=Date.now()-cycleStartMs;
          if(waitSec<=MAX_IN_CYCLE_WAIT_SEC&&elapsed+nextDelay+5000<MAX_CYCLE_DURATION_MS){
            await new Promise(res=>setTimeout(res,nextDelay));
            keepSending=true;
          }
        }
      } else {
        // Send failed — release lock, handle error
        const e=errType(httpStatus,respBody);
        if(e.t==='rate_limit'){
          rateLimited=true;
          // Progressive backoff instead of a flat 1h: most ML rate limits clear
          // in minutes, so a first hit should not cost an hour of sending.
          const lastHit=Number(cfg.rate_limit_last_hit||0);
          const strikes=(now-lastHit>7200000)?1:(Number(cfg.rate_limit_strikes||0)+1);
          const waitMin=[10,20,40,60][Math.min(strikes-1,3)];
          cfg.rate_limit_strikes=String(strikes);
          cfg.rate_limit_last_hit=String(now);
          cfg.rate_limit_until=String(now+waitMin*60000);
          await kv.put(env,'cfg',cfg);
          log(`🚫 Rate limit ML — pausando ${waitMin}min (ocorrência ${strikes})`,true);
          await tgSend(env,`🚫 <b>Rate limit do Mercado Livre</b>\nEnvios pausados por ${waitMin} min (ocorrência ${strikes}).`,{alert:'rate_limit'});
          await mutateOrder(orderId,(it)=>{if(it){delete it.sending_lock;delete it.sending_lock_key;}});
        } else if(e.t==='no_chat'||!chatOk){
          let abandoned=false;
          await mutateOrder(orderId,(it)=>{
            if(!it) return;
            delete it.sending_lock; delete it.sending_lock_key;
            if(!it.first_attempt_at) it.first_attempt_at=now;
            it.chat_retry_count=(it.chat_retry_count||0)+1;
            if(it.chat_retry_count>=12){
              abandoned=true;
              for(const rem of it.msgs_remaining){
                failed.unshift({order_id:orderId,item_id:it.item_id,buyer:it.buyer,
                  msg_num:'?',msg_text:rem.slice(0,80),
                  reason:'Chat bloqueado pelo ML (provável reclamação/contestação)',
                  error_type:'chat_blocked',failed_at:new Date().toISOString()});
              }
              if(failed.length>50) failed.splice(50); fChanged=true;
              return 'remove';
            } else {
              it.next_send_at=Date.now()+CHAT_RETRY_WAIT;
            }
          });
          if(abandoned) log(`🚫 Pedido #${orderId} — chat bloqueado após 12 tentativas. Removido da fila.`,true);
          else log(`⏳ Chat indisponível (HTTP ${httpStatus}) — pedido ${orderId} — tentando a cada 5min`,true);
        } else {
          let defFail=false;
          await mutateOrder(orderId,(it)=>{
            if(!it) return;
            delete it.sending_lock; delete it.sending_lock_key;
            it.retries=(it.retries||0)+1;
            if(it.retries<=MAX_RETRIES){
              it.next_send_at=Date.now()+120000;
            } else {
              defFail=true;
              it.msgs_remaining.shift();
              failed.unshift({order_id:orderId,item_id:it.item_id,buyer:it.buyer,
                msg_num:msgNum,msg_text:msg.slice(0,80),
                reason:e.m,error_type:e.t,failed_at:new Date().toISOString()});
              if(failed.length>50) failed.splice(50); fChanged=true;
              return it.msgs_remaining.length?undefined:'remove';
            }
          });
          if(defFail) log(`❌ Falha definitiva msg ${msgNum}→${orderId}: ${e.m}`,true);
          else { log(`🔁 Retry msg ${msgNum}→${orderId} (${e.m})`,true); await bumpStat(env,'retries'); }
        }
        break; // stop processing this order this cycle
      }
    }
  }
  if(fChanged) await kv.put(env,'failed_messages',failed);

  // ── 2. Confirmations (only after all messages sent) ───────────────────
  if(hasReadyConfirm){
    const liveQueue=await qList(env); // fresh read from per-order keys
    let confirmsMut=[...confirms]; const pending=[]; let cChanged=false;
    for(const item of confirmsMut){
      if(item.confirm_at>now){pending.push(item);continue;}
      if(liveQueue.some(q=>String(q.order_id)===String(item.order_id))){
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
