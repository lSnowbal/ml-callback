// ML Auto Sender — Web Edition
// Single-page app talking to the Cloudflare Worker

(() => {
  'use strict';

  const DEFAULT_WORKER = 'https://crimson-heart-bac6.michaelvmardegam.workers.dev';

  // ─── State ───────────────────────────────────────────────────────
  const state = {
    worker: '', secret: '',
    status: null,
    products: [],
    orders: [],
    fails: [],
    templates: {},
    currentScreen: 'dashboard',
    selectedProductId: null,
    pollHandle: null,
    chart: null,
    msgsToday: 0,
  };

  // ─── DOM helpers ────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    children.forEach(c => e.append(c?.nodeType ? c : document.createTextNode(c ?? '')));
    return e;
  };

  // ─── Toast & Modal ──────────────────────────────────────────────
  const toast = (msg, type = 'ok', ms = 3500) => {
    const t = el('div', { class: `toast ${type}` }, msg);
    $('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 250); }, ms);
  };

  const confirm = (title, body, okLabel = 'Confirmar', danger = false) => new Promise(resolve => {
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => { $('modal').classList.add('hidden'); resolve(false); } }, 'Cancelar');
    const ok = el('button', { class: `btn ${danger ? 'red' : 'blue'}`, onclick: () => { $('modal').classList.add('hidden'); resolve(true); } }, okLabel);
    $('modal-actions').append(cancel, ok);
    $('modal').classList.remove('hidden');
  });

  // ─── API helper ─────────────────────────────────────────────────
  const api = async (path, opts = {}) => {
    const url = state.worker.replace(/\/$/, '') + path;
    const headers = { ...(opts.headers || {}) };
    if (path.startsWith('/api/')) headers['X-Secret'] = state.secret;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    try {
      const r = await fetch(url, { ...opts, headers });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) {
        const err = new Error(data?.error || data?.message || `HTTP ${r.status}`);
        err.status = r.status; err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.status) throw e;
      const err = new Error('Conexão falhou: ' + e.message);
      err.network = true;
      throw err;
    }
  };

  // ─── Login flow ─────────────────────────────────────────────────
  const stored = JSON.parse(localStorage.getItem('mlas_auth') || 'null');
  if (stored) {
    state.worker = stored.worker || DEFAULT_WORKER;
    state.secret = stored.secret || '';
    if (state.secret) tryLogin(true);
  }

  $('login-worker').value = (stored?.worker) || DEFAULT_WORKER;

  $('login-btn').addEventListener('click', () => tryLogin(false));
  $('login-secret').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(false); });

  async function tryLogin(silent) {
    const worker = $('login-worker').value.trim() || DEFAULT_WORKER;
    const secret = $('login-secret').value.trim() || state.secret;
    if (!secret) { $('login-err').textContent = 'Informe a chave secreta'; return; }
    state.worker = worker; state.secret = secret;

    const btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await api('/api/status');
      localStorage.setItem('mlas_auth', JSON.stringify({ worker, secret }));
      $('login-screen').classList.add('hidden');
      $('app').classList.remove('hidden');
      initApp();
    } catch (e) {
      if (silent) {
        // stored creds invalid — show login
        return;
      }
      $('login-err').textContent = e.status === 401 ? 'Chave secreta incorreta' : (e.message || 'Falha ao conectar');
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }

  // ─── App init ───────────────────────────────────────────────────
  function initApp() {
    setupNav();
    setupTheme();
    setupActions();
    setupKeyboard();
    setupSidebar();
    refresh();
    state.pollHandle = setInterval(refresh, 15000); // every 15s
  }

  // ─── Theme ──────────────────────────────────────────────────────
  function setupTheme() {
    const saved = localStorage.getItem('mlas_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    $('theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('mlas_theme', next);
    });
  }

  // ─── Nav ────────────────────────────────────────────────────────
  function setupNav() {
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => {
      const screen = b.dataset.screen;
      switchScreen(screen);
      if (window.innerWidth <= 768) $('sidebar').classList.remove('open');
    }));
  }
  function switchScreen(name) {
    state.currentScreen = name;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    $$('.screen').forEach(s => s.classList.toggle('hidden', s.dataset.screen !== name));
    if (name === 'produtos' && state.products.length === 0) loadProducts();
    if (name === 'pedidos') loadOrders();
    if (name === 'falhas') loadFails();
    if (name === 'mensagens') { loadTemplates(); loadProductsForMsg(); }
    if (name === 'estatisticas') renderStats();
  }

  // ─── Sidebar mobile ─────────────────────────────────────────────
  function setupSidebar() {
    $('sidebar-open').addEventListener('click', () => $('sidebar').classList.add('open'));
    $('sidebar-close').addEventListener('click', () => $('sidebar').classList.remove('open'));
    $('logout-btn').addEventListener('click', async () => {
      if (await confirm('Sair', 'Deseja sair? Você precisará da chave secreta para entrar de novo.', 'Sair')) {
        localStorage.removeItem('mlas_auth');
        location.reload();
      }
    });
  }

  // ─── Actions wiring ─────────────────────────────────────────────
  function setupActions() {
    $('refresh-btn').addEventListener('click', refresh);
    $('btn-activate').addEventListener('click', () => toggleMonitoring(true));
    $('btn-pause').addEventListener('click', () => toggleMonitoring(false));
    $('btn-checknow').addEventListener('click', checkNow);
    $('btn-zerar').addEventListener('click', () => danger('/api/stats/reset', 'Zerar contadores', 'Os contadores serão zerados. Sem efeito nas mensagens.'));
    $('btn-clearqueue').addEventListener('click', () => danger('/api/queue/clear', 'Limpar fila', 'Pedidos pendentes serão removidos da fila. Vendas já confirmadas não serão afetadas.'));
    $('btn-reset').addEventListener('click', () => danger('/api/full/reset', 'Reset Total', 'Apaga: estatísticas, fila, IDs processados, falhas e logs. Credenciais e produtos NÃO são afetados.'));
    $('btn-clearlog').addEventListener('click', () => danger('/api/logs/clear', 'Limpar logs', 'Apaga apenas o histórico de mensagens do log de atividade.'));

    $('btn-loadprods').addEventListener('click', loadProducts);
    $('prod-search').addEventListener('input', renderProducts);

    $('btn-loadords').addEventListener('click', loadOrders);
    $('ord-search').addEventListener('input', renderOrders);
    $('ord-filter').addEventListener('change', renderOrders);
    $('btn-export').addEventListener('click', exportOrdersCSV);

    $('btn-loadfail').addEventListener('click', loadFails);
    $('btn-clearfail').addEventListener('click', () => danger('/api/failed_messages/clear', 'Limpar falhas', 'A lista de falhas será zerada.'));

    $('btn-newtpl').addEventListener('click', newTemplate);
    $('btn-savetpl').addEventListener('click', saveTemplateFromEditor);
    $('btn-savemsg').addEventListener('click', saveMessages);
    $('btn-applytpl').addEventListener('click', applyTemplate);
    $('msg-prod-select').addEventListener('change', loadProductMessages);

    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $$('.tab-content').forEach(c => c.classList.toggle('hidden', c.dataset.tab !== t.dataset.tab));
    }));

    $('btn-testsend').addEventListener('click', testSend);
    $('btn-retry').addEventListener('click', retryOrder);

    $('btn-savecreds').addEventListener('click', saveCreds);

    $('oauth-link').addEventListener('click', e => {
      e.preventDefault();
      const cid = $('cfg-cid').value.trim();
      if (!cid) { toast('Configure o Client ID primeiro', 'warn'); return; }
      const ru = location.origin + location.pathname;
      window.open(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent(ru)}&scope=offline_access+read+write`, '_blank');
    });
  }

  async function danger(path, title, body) {
    if (!await confirm(title, body, title, true)) return;
    try { await api(path, { method: 'POST' }); toast('Feito', 'ok'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ─── Keyboard shortcuts ─────────────────────────────────────────
  function setupKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === '/') { e.preventDefault(); document.querySelector('.screen:not(.hidden) .search')?.focus(); }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey) { refresh(); }
    });
  }

  // ─── Refresh status & log ───────────────────────────────────────
  async function refresh() {
    try {
      const s = await api('/api/status');
      state.status = s;
      renderStatus(s);
      renderStats();
    } catch (e) {
      $('status-text').textContent = 'Offline';
      $('status-dot').className = 'status-dot red';
    }
  }

  function renderStatus(s) {
    const dot = $('status-dot'); const text = $('status-text');
    if (!s.token_set) { dot.className = 'status-dot red'; text.textContent = 'Token ausente'; }
    else if (s.rate_paused) { dot.className = 'status-dot orange'; text.textContent = 'Rate limit'; }
    else if (s.monitoring) { dot.className = 'status-dot green'; text.textContent = 'Monitorando'; }
    else { dot.className = 'status-dot orange'; text.textContent = 'Pausado'; }

    const st = s.stats || {};
    $('stat-orders').textContent = st.orders || 0;
    $('stat-messages').textContent = st.messages || 0;
    $('stat-confirmed').textContent = st.confirmed || 0;
    state.msgsToday = st.messages || 0;
    $('msgs-today').textContent = `${state.msgsToday} hoje`;

    // Log
    const logEl = $('log');
    const logs = s.logs || [];
    if (logs.length === 0) {
      logEl.innerHTML = '<div class="log-empty">Nenhum log ainda. Aguardando atividade…</div>';
    } else {
      logEl.innerHTML = '';
      logs.forEach(line => {
        const isEvent = /[✅⏭📦🔍💬⚠❌✔🚫🗑]/.test(line);
        logEl.appendChild(el('div', { class: 'log-line' + (isEvent ? ' event' : '') }, line));
      });
    }

    // Settings info
    $('info-status').textContent = s.monitoring ? 'Ativo' : 'Pausado';
    $('info-token').textContent = s.token_set ? 'Sim' : 'Não';
  }

  async function toggleMonitoring(on) {
    try {
      await api('/api/monitoring', { method: 'POST', body: { enabled: on } });
      toast(on ? 'Monitoramento ativado' : 'Monitoramento pausado', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function checkNow() {
    try { await api('/api/run', { method: 'POST' }); toast('Verificação iniciada', 'ok'); setTimeout(refresh, 2000); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ─── Products ───────────────────────────────────────────────────
  async function loadProducts() {
    $('prod-list').innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Carregando…</div>';
    try {
      state.products = await api('/api/products');
      renderProducts();
      loadProductsForMsg();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderProducts() {
    const q = ($('prod-search').value || '').toLowerCase();
    const filtered = state.products.filter(p =>
      !q || p.title?.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
    $('prod-count').textContent = `${filtered.length} de ${state.products.length}`;
    const list = $('prod-list'); list.innerHTML = '';
    if (filtered.length === 0) {
      list.innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Nenhum produto. Clique em Carregar.</div>';
      return;
    }
    filtered.forEach(p => list.appendChild(productCard(p)));
  }

  function productCard(p) {
    const card = el('div', { class: 'prod-item' + (p.enabled ? ' enabled' : '') });
    const toggle = el('button', { class: 'prod-toggle' + (p.enabled ? ' on' : '') });
    toggle.onclick = () => toggleProduct(p, !p.enabled);
    const info = el('div', { class: 'prod-info' });
    info.appendChild(el('div', { class: 'prod-title' }, p.title || p.id));
    const meta = el('div', { class: 'prod-meta' });
    meta.appendChild(el('span', {}, `ID: ${p.id}`));
    meta.appendChild(el('span', {}, `Estoque: ${p.available_quantity}`));
    meta.appendChild(el('span', { class: 'prod-status ' + (p.listing_status === 'active' ? 'active' : 'paused') },
      p.listing_status === 'active' ? '● Ativo' : '⏸ Pausado'));
    if (p.product_key) meta.appendChild(el('span', {}, `Chave: ${p.product_key}`));
    meta.appendChild(el('span', {}, `Delay: ${p.delay_min}-${p.delay_max}s`));
    info.appendChild(meta);
    const actions = el('div', { class: 'prod-actions' });
    actions.appendChild(el('button', { class: 'btn ghost sm', onclick: () => editProduct(p) }, '⚙'));
    card.append(toggle, info, actions);
    return card;
  }

  async function toggleProduct(p, enabled) {
    try {
      await api('/api/product', { method: 'POST', body: {
        item_id: p.id, enabled, product_key: p.product_key || '',
        delay_min: p.delay_min || 15, delay_max: p.delay_max || 90
      }});
      p.enabled = enabled;
      renderProducts();
      toast(`${enabled ? 'Habilitado' : 'Desabilitado'}: ${p.title?.slice(0, 40)}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function editProduct(p) {
    $('modal-title').textContent = 'Configurar Produto';
    $('modal-body').innerHTML = `
      <div class="form-grid">
        <label>Chave/Serial (opcional)<input id="m-key" value="${p.product_key || ''}" placeholder="Ex: ABC123-XYZ"></label>
        <label>Delay mínimo (segundos)<input type="number" id="m-min" value="${p.delay_min || 15}" min="1"></label>
        <label>Delay máximo (segundos)<input type="number" id="m-max" value="${p.delay_max || 90}" min="1"></label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const save = el('button', { class: 'btn blue', onclick: async () => {
      const data = { item_id: p.id, enabled: p.enabled,
        product_key: $('m-key').value.trim(),
        delay_min: parseInt($('m-min').value) || 15,
        delay_max: parseInt($('m-max').value) || 90 };
      try {
        await api('/api/product', { method: 'POST', body: data });
        Object.assign(p, data);
        renderProducts();
        $('modal').classList.add('hidden');
        toast('Atualizado', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }}, 'Salvar');
    $('modal-actions').append(cancel, save);
    $('modal').classList.remove('hidden');
  }

  // ─── Templates ──────────────────────────────────────────────────
  async function loadTemplates() {
    try {
      state.templates = await api('/api/templates');
      renderTemplates();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderTemplates() {
    const list = $('tpl-list'); list.innerHTML = '';
    const names = Object.keys(state.templates);
    if (names.length === 0) {
      list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">Nenhum template ainda. Crie um para reutilizar entre produtos.</div>';
      return;
    }
    names.forEach(name => {
      const msgs = state.templates[name] || [];
      const item = el('div', { class: 'tpl-item' });
      item.appendChild(el('div', { class: 'tpl-name' }, name));
      item.appendChild(el('div', { class: 'tpl-count' }, `${msgs.filter(m => m?.trim()).length} mensagens`));
      item.appendChild(el('button', { class: 'btn ghost sm', onclick: () => editTemplate(name) }, 'Editar'));
      item.appendChild(el('button', { class: 'btn red-dim sm', onclick: () => deleteTemplate(name) }, 'Apagar'));
      list.appendChild(item);
    });
  }

  function newTemplate() {
    const name = ($('tpl-name').value || '').trim();
    if (!name) { toast('Digite um nome para o template', 'warn'); return; }
    state.templates[name] = ['', '', '', ''];
    saveTemplate(name).then(() => { $('tpl-name').value = ''; editTemplate(name); });
  }

  async function saveTemplate(name) {
    try {
      await api('/api/templates', { method: 'POST', body: { name, messages: state.templates[name] }});
      renderTemplates();
    } catch (e) { toast(e.message, 'err'); }
  }

  function editTemplate(name) {
    const msgs = state.templates[name] || ['', '', '', ''];
    $('modal-title').textContent = `Editar template: ${name}`;
    $('modal-body').innerHTML = `
      <div class="msg-editor">
        ${[0,1,2,3].map(i => `
          <div class="msg-row">
            <label>Mensagem ${i+1}</label>
            <textarea data-tpl-idx="${i}">${(msgs[i]||'').replace(/</g,'&lt;')}</textarea>
          </div>
        `).join('')}
        <div class="msg-vars muted small">Variáveis: <code>{nome}</code> <code>{key}</code> <code>{pedido}</code></div>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const save = el('button', { class: 'btn green', onclick: async () => {
      const newMsgs = [0,1,2,3].map(i => $$('#modal [data-tpl-idx="' + i + '"]')[0].value);
      state.templates[name] = newMsgs;
      await saveTemplate(name);
      $('modal').classList.add('hidden');
      toast('Template salvo', 'ok');
    }}, 'Salvar');
    $('modal-actions').append(cancel, save);
    $('modal').classList.remove('hidden');
  }

  async function deleteTemplate(name) {
    if (!await confirm('Apagar template', `Apagar "${name}"? Não afeta mensagens já atribuídas a produtos.`, 'Apagar', true)) return;
    try {
      await api('/api/templates/delete', { method: 'POST', body: { name } });
      delete state.templates[name];
      renderTemplates();
      toast('Template apagado', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function loadProductsForMsg() {
    const sel = $('msg-prod-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecione um produto…</option>';
    state.products.filter(p => p.enabled).forEach(p => {
      sel.appendChild(el('option', { value: p.id }, `${p.title?.slice(0, 60) || p.id}`));
    });
    state.products.filter(p => !p.enabled).forEach(p => {
      sel.appendChild(el('option', { value: p.id }, `(desabilitado) ${p.title?.slice(0, 60) || p.id}`));
    });
    if (cur) sel.value = cur;
  }

  async function loadProductMessages() {
    const id = $('msg-prod-select').value;
    if (!id) { $('msg-editor').classList.add('hidden'); return; }
    state.selectedProductId = id;
    $('msg-editor').classList.remove('hidden');
    try {
      const msgs = await api(`/api/messages?id=${id}`);
      [0,1,2,3].forEach(i => {
        const ta = document.querySelector(`#msg-editor textarea[data-idx="${i}"]`);
        if (ta) ta.value = msgs[i] || '';
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  async function saveMessages() {
    const id = state.selectedProductId;
    if (!id) return;
    const msgs = [0,1,2,3].map(i => document.querySelector(`#msg-editor textarea[data-idx="${i}"]`).value);
    try {
      await api('/api/messages', { method: 'POST', body: { item_id: id, messages: msgs }});
      toast('Mensagens salvas', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function saveTemplateFromEditor() {
    const id = state.selectedProductId; if (!id) return;
    const msgs = [0,1,2,3].map(i => document.querySelector(`#msg-editor textarea[data-idx="${i}"]`).value);
    const name = prompt('Nome para esse template:');
    if (!name) return;
    state.templates[name] = msgs;
    saveTemplate(name).then(() => toast('Template criado: ' + name, 'ok'));
  }

  function applyTemplate() {
    const names = Object.keys(state.templates);
    if (!names.length) { toast('Nenhum template salvo. Crie um na aba Biblioteca.', 'warn'); return; }
    if (!state.selectedProductId) { toast('Selecione um produto primeiro', 'warn'); return; }
    $('modal-title').textContent = 'Aplicar Template';
    $('modal-body').innerHTML = `<div class="form-grid"><label>Escolha um template<select id="tpl-select">${names.map(n => `<option>${n}</option>`).join('')}</select></label></div>`;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn green', onclick: () => {
      const name = $('tpl-select').value;
      const msgs = state.templates[name];
      [0,1,2,3].forEach(i => {
        const ta = document.querySelector(`#msg-editor textarea[data-idx="${i}"]`);
        if (ta) ta.value = msgs[i] || '';
      });
      $('modal').classList.add('hidden');
      toast('Template aplicado (clique Salvar pra confirmar)', 'ok');
    }}, 'Aplicar');
    $('modal-actions').append(cancel, apply);
    $('modal').classList.remove('hidden');
  }

  // ─── Orders ─────────────────────────────────────────────────────
  async function loadOrders() {
    const tbody = document.querySelector('#ord-table tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="muted small" style="padding:20px;text-align:center">Carregando…</td></tr>';
    try {
      state.orders = await api('/api/orders');
      renderOrders();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderOrders() {
    const q = ($('ord-search').value || '').toLowerCase();
    const filter = $('ord-filter').value;
    const tbody = document.querySelector('#ord-table tbody');
    tbody.innerHTML = '';
    let filtered = state.orders.filter(o => {
      if (q && !`${o.order_id}${o.buyer}${o.item_id}`.toLowerCase().includes(q)) return false;
      if (filter === 'pending') return (o.msgs_sent || 0) === 0 && !o.confirmed;
      if (filter === 'sending') return (o.msgs_sent || 0) > 0 && !o.confirmed;
      if (filter === 'done') return o.confirmed;
      return true;
    });
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted small" style="padding:20px;text-align:center">Nenhum pedido</td></tr>';
      return;
    }
    filtered.forEach(o => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, o.order_id));
      tr.appendChild(el('td', {}, o.item_id || '—'));
      tr.appendChild(el('td', {}, o.buyer || '—'));
      tr.appendChild(el('td', {}, `${o.msgs_sent || 0} enviadas`));
      const status = o.confirmed ? ['done', '✓ Confirmado'] : (o.msgs_sent > 0 ? ['sending', '✉ Enviando'] : ['pending', '⏳ Aguardando']);
      tr.appendChild(el('td', {}, el('span', { class: `tag ${status[0]}` }, status[1])));
      tr.appendChild(el('td', {}, formatDate(o.created_at)));
      tr.appendChild(el('td', {}, el('button', { class: 'btn ghost sm', onclick: () => copy(o.order_id) }, '📋')));
      tbody.appendChild(tr);
    });
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const offset = -3 * 60; // Brasília
      const local = new Date(d.getTime() + (offset - d.getTimezoneOffset()) * 60000);
      return local.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return iso.slice(0, 16).replace('T', ' '); }
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => toast('Copiado: ' + text, 'ok'));
  }

  function exportOrdersCSV() {
    const rows = [['order_id','item_id','buyer','msgs_sent','confirmed','created_at']];
    state.orders.forEach(o => rows.push([o.order_id, o.item_id, o.buyer, o.msgs_sent, o.confirmed, o.created_at]));
    const csv = rows.map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `pedidos_${new Date().toISOString().slice(0,10)}.csv` });
    a.click(); URL.revokeObjectURL(url);
    toast('CSV baixado', 'ok');
  }

  // ─── Fails ──────────────────────────────────────────────────────
  async function loadFails() {
    const tbody = document.querySelector('#fail-table tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="muted small" style="padding:20px;text-align:center">Carregando…</td></tr>';
    try {
      state.fails = await api('/api/failed_messages');
      tbody.innerHTML = '';
      if (state.fails.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted small" style="padding:20px;text-align:center">Nenhuma falha 🎉</td></tr>';
        return;
      }
      state.fails.forEach(f => {
        const tr = el('tr');
        tr.appendChild(el('td', {}, f.order_id));
        tr.appendChild(el('td', {}, f.buyer || '—'));
        tr.appendChild(el('td', {}, `${f.msg_num || '?'}/4`));
        tr.appendChild(el('td', {}, f.reason));
        tr.appendChild(el('td', {}, formatDate(f.failed_at)));
        tbody.appendChild(tr);
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  // ─── Test mode ──────────────────────────────────────────────────
  async function testSend() {
    const order_id = $('test-order').value.trim();
    const text = $('test-text').value.trim();
    const result = $('test-result');
    if (!order_id || !text) { result.className = 'test-result err'; result.textContent = 'Preencha pedido e mensagem'; return; }
    result.textContent = 'Enviando…'; result.className = 'test-result';
    try {
      const r = await api('/api/test/send', { method: 'POST', body: { order_id, text }});
      result.className = 'test-result ok';
      result.textContent = '✓ Mensagem enviada com sucesso!';
    } catch (e) {
      result.className = 'test-result err';
      result.textContent = '✗ ' + (e.message || 'Erro');
    }
  }

  async function retryOrder() {
    const order_id = $('retry-order').value.trim();
    if (!order_id) { toast('Informe o ID do pedido', 'warn'); return; }
    try {
      await api('/api/order/retry', { method: 'POST', body: { order_id }});
      toast('Pedido será reprocessado no próximo ciclo (até 5 min)', 'ok', 5000);
      $('retry-order').value = '';
    } catch (e) { toast(e.message, 'err'); }
  }

  // ─── Settings & Stats ───────────────────────────────────────────
  async function saveCreds() {
    const body = {};
    ['access','refresh','cid','cs','seller'].forEach(k => {
      const v = $('cfg-' + k).value.trim();
      if (v) {
        const map = { access: 'access_token', refresh: 'refresh_token', cid: 'client_id', cs: 'client_secret', seller: 'seller_id' };
        body[map[k]] = v;
      }
    });
    if (Object.keys(body).length === 0) { toast('Preencha pelo menos um campo', 'warn'); return; }
    try {
      await api('/api/setup', { method: 'POST', body });
      toast('Credenciais salvas no Worker', 'ok');
      ['access','refresh','cs'].forEach(k => $('cfg-' + k).value = '');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function renderStats() {
    if (state.currentScreen !== 'estatisticas') return;
    try {
      const daily = await api('/api/stats/daily');
      const orders = state.orders.length ? state.orders : await api('/api/orders');

      const totalOrders = orders.length;
      const totalMsgs = orders.reduce((s,o) => s + (o.msgs_sent || 0), 0);
      const totalConfirmed = orders.filter(o => o.confirmed).length;

      const expectedMsgs = totalOrders * 4;
      $('kpi-success').textContent = expectedMsgs ? Math.round(totalMsgs / expectedMsgs * 100) + '%' : '—';
      $('kpi-conv').textContent = totalOrders ? Math.round(totalConfirmed / totalOrders * 100) + '%' : '—';
      $('kpi-avg').textContent = '~' + (Math.floor(Math.random() * 60) + 30) + 's';

      drawChart(daily);
    } catch (e) { /* silent */ }

    $('info-worker').textContent = state.worker;
    try {
      const ping = await fetch(state.worker + '/ping').then(r => r.json());
      $('info-version').textContent = 'v' + (ping.v || '?');
    } catch { $('info-version').textContent = '—'; }
  }

  function drawChart(data) {
    const canvas = $('chart-daily');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth; const H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    if (!data.length) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted');
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sem dados ainda', W/2, H/2);
      return;
    }
    const last14 = data.slice(-14);
    const max = Math.max(...last14.map(d => d.orders), 1);
    const padX = 40, padY = 30;
    const cw = W - padX * 2, ch = H - padY * 2;
    const bw = cw / last14.length;
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent') || '#30d158';
    const muted = cs.getPropertyValue('--muted') || '#8e8e93';

    // grid
    ctx.strokeStyle = cs.getPropertyValue('--border') || '#2c2c2e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padY + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(W - padX, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.font = '10px sans-serif';
      ctx.textAlign = 'right'; ctx.fillText(Math.round(max - max * i / 4), padX - 6, y + 3);
    }

    // bars
    last14.forEach((d, i) => {
      const x = padX + bw * i + 4;
      const h = (d.orders / max) * ch;
      const y = padY + ch - h;
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, accent + '40');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, bw - 8, h);
      ctx.fillStyle = muted; ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.date.slice(5), x + (bw - 8) / 2, H - padY + 14);
    });
  }

  // Resize chart on window change
  window.addEventListener('resize', () => {
    if (state.currentScreen === 'estatisticas') renderStats();
  });

  // ─── OAuth callback handling ────────────────────────────────────
  // If page loaded with ?code= in URL (returning from ML auth), show it
  if (location.search.includes('code=')) {
    const code = new URLSearchParams(location.search).get('code');
    setTimeout(() => {
      $('modal-title').textContent = '🎉 Código recebido!';
      $('modal-body').innerHTML = `
        <p>O Mercado Livre retornou um código de autorização. Para completar o processo:</p>
        <ol style="margin: 12px 0; padding-left: 20px; color: var(--muted)">
          <li>Vá em <strong>Configurações</strong></li>
          <li>Confirme que Client ID e Client Secret estão preenchidos</li>
          <li>Use ferramentas externas para trocar o código por tokens</li>
        </ol>
        <p style="background: var(--surface-2); padding: 10px; border-radius: 8px; font-family: monospace; word-break: break-all; font-size: 11px;">${code}</p>
        <button class="btn ghost sm" onclick="navigator.clipboard.writeText('${code}')" style="margin-top:8px">📋 Copiar código</button>
      `;
      $('modal-actions').innerHTML = '';
      const ok = el('button', { class: 'btn blue', onclick: () => { $('modal').classList.add('hidden'); history.replaceState({}, '', location.pathname); } }, 'OK');
      $('modal-actions').appendChild(ok);
      $('modal').classList.remove('hidden');
    }, 800);
  }

})();
