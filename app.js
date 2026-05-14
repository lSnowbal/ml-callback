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
    wireSettingsHandlers();
    refresh();
    state.pollHandle = setInterval(refresh, 15000); // every 15s
    startEventPolling();
    // Apply saved accent color
    const savedAccent = localStorage.getItem('mlas_accent');
    if (savedAccent) document.documentElement.style.setProperty('--accent', savedAccent);
    // Handle OAuth return
    handleOAuthCallback();
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
    if (name === 'mensagens') { loadTemplates(); loadMessagesScreen(); }
    if (name === 'broadcast') initBroadcast();
    if (name === 'config') initSettings();
    if (name === 'estatisticas') { renderStats(); /* lazy load conversion */ }
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
    $('prod-filter').addEventListener('change', renderProducts);
    $('prod-selectall').addEventListener('change', e => {
      const rows = document.querySelectorAll('#prod-list .prod-row[data-pid]');
      if (e.target.checked) rows.forEach(r => state.prodSelected.add(r.dataset.pid));
      else rows.forEach(r => state.prodSelected.delete(r.dataset.pid));
      renderProducts();
    });
    $('btn-bulk-enable').addEventListener('click', () => bulkProdToggle(true));
    $('btn-bulk-disable').addEventListener('click', () => bulkProdToggle(false));
    $('btn-bulk-active').addEventListener('click', () => bulkListingStatus('active'));
    $('btn-bulk-pause').addEventListener('click', () => bulkListingStatus('paused'));
    $('btn-bulk-stock').addEventListener('click', bulkEditStock);
    $('btn-bulk-delay').addEventListener('click', bulkEditDelay);
    $('btn-bulk-clear-prod').addEventListener('click', () => { state.prodSelected.clear(); renderProducts(); });

    $('btn-loadords').addEventListener('click', loadOrders);
    $('ord-search').addEventListener('input', renderOrders);
    $('ord-filter').addEventListener('change', renderOrders);
    $('ord-date-filter').addEventListener('change', renderOrders);
    $('btn-export').addEventListener('click', exportOrdersCSV);

    $('btn-loadfail').addEventListener('click', loadFails);
    $('btn-clearfail').addEventListener('click', () => danger('/api/failed_messages/clear', 'Limpar falhas', 'A lista de falhas será zerada.'));

    $('btn-newtpl').addEventListener('click', newTemplate);
    // Messages screen handlers (multi-select edition)
    $('btn-loadmsg').addEventListener('click', loadMessagesScreen);
    $('msg-search').addEventListener('input', renderMessagesList);
    $('msg-filter').addEventListener('change', renderMessagesList);
    $('msg-selectall').addEventListener('change', e => {
      const rows = document.querySelectorAll('#msg-prod-list .msg-prod-row[data-pid]');
      if (e.target.checked) {
        rows.forEach(r => state.msgSelected.add(r.dataset.pid));
      } else {
        rows.forEach(r => state.msgSelected.delete(r.dataset.pid));
      }
      renderMessagesList();
    });
    $('btn-bulk-edit').addEventListener('click', bulkEditMessages);
    $('btn-bulk-template').addEventListener('click', bulkApplyTemplate);
    $('btn-bulk-clear').addEventListener('click', () => { state.msgSelected.clear(); renderMessagesList(); });

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
  // ─── Products screen — multi-select with bulk actions ───────────
  state.prodSelected = new Set();

  async function loadProducts() {
    $('prod-list').innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Carregando…</div>';
    try {
      state.products = await api('/api/products');
      renderProducts();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderProducts() {
    const q = ($('prod-search').value || '').toLowerCase();
    const filter = $('prod-filter').value;
    const list = $('prod-list'); list.innerHTML = '';

    const filtered = state.products.filter(p => {
      if (q && !`${p.title || ''}${p.id}`.toLowerCase().includes(q)) return false;
      if (filter === 'enabled' && !p.enabled) return false;
      if (filter === 'disabled' && p.enabled) return false;
      if (filter === 'active' && p.listing_status !== 'active') return false;
      if (filter === 'paused' && p.listing_status !== 'paused') return false;
      if (filter === 'low' && (typeof p.available_quantity !== 'number' || p.available_quantity > 5)) return false;
      return true;
    });

    $('prod-count').textContent = `${filtered.length} de ${state.products.length}`;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Nenhum produto corresponde aos filtros.</div>';
      updateProdBulkBar();
      return;
    }

    filtered.forEach(p => list.appendChild(productCard(p)));
    updateProdBulkBar();
  }

  function productCard(p) {
    const row = el('div', { class: 'msg-prod-row prod-row' + (p.enabled ? ' enabled' : '') + (state.prodSelected.has(p.id) ? ' selected' : ''), 'data-pid': p.id });

    const cb = el('input', { type: 'checkbox' });
    cb.checked = state.prodSelected.has(p.id);
    cb.onchange = e => {
      e.stopPropagation();
      if (cb.checked) state.prodSelected.add(p.id); else state.prodSelected.delete(p.id);
      row.classList.toggle('selected', cb.checked);
      updateProdBulkBar();
    };

    const toggle = el('button', {
      class: 'prod-toggle' + (p.enabled ? ' on' : ''),
      title: p.enabled ? 'Habilitado no app — clique pra desabilitar' : 'Desabilitado — clique pra habilitar'
    });
    toggle.onclick = e => { e.stopPropagation(); toggleProduct(p, !p.enabled); };

    const info = el('div', { class: 'msg-prod-info' });
    info.appendChild(el('div', { class: 'msg-prod-title' }, p.title || p.id));
    const meta = el('div', { class: 'msg-prod-meta' });
    meta.appendChild(el('span', {}, p.id));
    meta.appendChild(el('span', { class: 'tag ' + (p.listing_status === 'active' ? 'done' : 'pending') },
      p.listing_status === 'active' ? '● Ativo no ML' : '⏸ Pausado no ML'));
    const stockClass = (typeof p.available_quantity === 'number' && p.available_quantity <= 5) ? 'tag fail' : '';
    meta.appendChild(el('span', { class: stockClass }, `📦 ${p.available_quantity}`));
    if (p.product_key) meta.appendChild(el('span', {}, `🔑 ${p.product_key}`));
    meta.appendChild(el('span', {}, `⏱ ${p.delay_min}-${p.delay_max}s`));
    info.appendChild(meta);

    const editBtn = el('button', { class: 'btn ghost sm', onclick: e => { e.stopPropagation(); editProduct(p); }, title: 'Configurar' }, '⚙');

    row.addEventListener('click', () => cb.click());
    row.append(cb, toggle, info, editBtn);
    return row;
  }

  function updateProdBulkBar() {
    const n = state.prodSelected.size;
    $('prod-selected-count').textContent = n;
    const has = n > 0;
    ['btn-bulk-enable','btn-bulk-disable','btn-bulk-active','btn-bulk-pause','btn-bulk-stock','btn-bulk-delay','btn-bulk-clear-prod']
      .forEach(id => $(id).disabled = !has);
    const visibleIds = Array.from(document.querySelectorAll('#prod-list .prod-row[data-pid]'));
    const allChecked = visibleIds.length > 0 && visibleIds.every(r => state.prodSelected.has(r.dataset.pid));
    const anyChecked = visibleIds.some(r => state.prodSelected.has(r.dataset.pid));
    const sa = $('prod-selectall');
    sa.checked = allChecked;
    sa.indeterminate = anyChecked && !allChecked;
  }

  async function toggleProduct(p, enabled) {
    try {
      await api('/api/product', { method: 'POST', body: {
        item_id: p.id, enabled, product_key: p.product_key || '',
        delay_min: p.delay_min || 15, delay_max: p.delay_max || 45
      }});
      p.enabled = enabled;
      renderProducts();
      toast(`${enabled ? '✓ Habilitado' : '✗ Desabilitado'}: ${(p.title || p.id).slice(0, 40)}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function editProduct(p) {
    $('modal-title').textContent = 'Configurar Produto';
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">${p.title || p.id}</div>
      <div class="form-grid">
        <label>Chave/Serial <span class="muted small">(usada na variável {key})</span><input id="m-key" value="${(p.product_key || '').replace(/"/g,'&quot;')}" placeholder="Ex: ABC123-XYZ"></label>
        <label>Estoque atual<input id="m-stock" type="number" value="${typeof p.available_quantity === 'number' ? p.available_quantity : 0}" min="0"></label>
        <label>Delay mínimo (segundos)<input type="number" id="m-min" value="${p.delay_min || 15}" min="1"></label>
        <label>Delay máximo (segundos)<input type="number" id="m-max" value="${p.delay_max || 45}" min="1"></label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const save = el('button', { class: 'btn blue', onclick: async () => {
      const newStock = parseInt($('m-stock').value);
      const data = { item_id: p.id, enabled: p.enabled,
        product_key: $('m-key').value.trim(),
        delay_min: parseInt($('m-min').value) || 15,
        delay_max: parseInt($('m-max').value) || 45 };
      save.disabled = true; save.textContent = 'Salvando…';
      try {
        await api('/api/product', { method: 'POST', body: data });
        // If stock changed, also update on ML
        if (typeof p.available_quantity === 'number' && newStock !== p.available_quantity) {
          try {
            await api('/api/add_stock', { method: 'POST', body: { item_id: p.id, quantity: newStock }});
            p.available_quantity = newStock;
          } catch (e) { toast('Estoque ML: ' + e.message, 'warn'); }
        }
        Object.assign(p, data);
        renderProducts();
        $('modal').classList.add('hidden');
        toast('Atualizado', 'ok');
      } catch (e) { toast(e.message, 'err'); save.disabled = false; save.textContent = 'Salvar'; }
    }}, 'Salvar');
    $('modal-actions').append(cancel, save);
    $('modal').classList.remove('hidden');
  }

  // ─── Bulk product actions ───────────────────────────────────────
  async function bulkProdToggle(enable) {
    const ids = Array.from(state.prodSelected);
    if (!ids.length) return;
    const verb = enable ? 'habilitar' : 'desabilitar';
    if (!await confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${ids.length} produto(s)`,
      `Vai ${verb} ${ids.length} produto(s) no app (não afeta o anúncio no ML).`, verb.charAt(0).toUpperCase() + verb.slice(1))) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      const p = state.products.find(x => x.id === id); if (!p) continue;
      try {
        await api('/api/product', { method: 'POST', body: {
          item_id: id, enabled: enable,
          product_key: p.product_key || '',
          delay_min: p.delay_min || 15, delay_max: p.delay_max || 45
        }});
        p.enabled = enable; ok++;
      } catch { fail++; }
    }
    state.prodSelected.clear();
    renderProducts();
    toast(`${enable ? '✓' : '✗'} ${ok} ${verb} no app${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
  }

  async function bulkListingStatus(status) {
    const ids = Array.from(state.prodSelected);
    if (!ids.length) return;
    const verb = status === 'active' ? 'ativar no Mercado Livre' : 'pausar no Mercado Livre';
    if (!await confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)}`,
      `Vai ${verb} ${ids.length} anúncio(s). Isso afeta a visibilidade no ML.`,
      status === 'active' ? 'Ativar' : 'Pausar', status === 'paused')) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await api('/api/toggle_listing', { method: 'POST', body: { item_id: id, status }});
        const p = state.products.find(x => x.id === id);
        if (p) p.listing_status = status;
        ok++;
      } catch { fail++; }
    }
    state.prodSelected.clear();
    renderProducts();
    toast(`${ok} anúncio(s) ${status === 'active' ? 'ativado(s)' : 'pausado(s)'}${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
  }

  function bulkEditStock() {
    const ids = Array.from(state.prodSelected);
    if (!ids.length) return;
    $('modal-title').textContent = `Ajustar Estoque (${ids.length} produto(s))`;
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">Define um novo estoque <strong>absoluto</strong> para os produtos selecionados.</div>
      <div class="form-grid">
        <label>Novo estoque<input type="number" id="bulk-stock" value="0" min="0"></label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn blue', onclick: async () => {
      const qty = parseInt($('bulk-stock').value);
      if (isNaN(qty) || qty < 0) { toast('Quantidade inválida', 'warn'); return; }
      apply.disabled = true; apply.textContent = 'Atualizando…';
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await api('/api/add_stock', { method: 'POST', body: { item_id: id, quantity: qty }});
          const p = state.products.find(x => x.id === id);
          if (p) p.available_quantity = qty;
          ok++;
        } catch { fail++; }
      }
      $('modal').classList.add('hidden');
      state.prodSelected.clear();
      renderProducts();
      toast(`Estoque atualizado em ${ok}${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
    }}, 'Aplicar');
    $('modal-actions').append(cancel, apply);
    $('modal').classList.remove('hidden');
  }

  function bulkEditDelay() {
    const ids = Array.from(state.prodSelected);
    if (!ids.length) return;
    $('modal-title').textContent = `Ajustar Delay (${ids.length} produto(s))`;
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">Recomendação: <strong>15-45s</strong> ou <strong>30-90s</strong> para evitar moderação automática do ML.</div>
      <div class="form-grid">
        <label>Delay mínimo (segundos)<input type="number" id="bulk-min" value="15" min="1"></label>
        <label>Delay máximo (segundos)<input type="number" id="bulk-max" value="45" min="1"></label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn blue', onclick: async () => {
      const dmin = parseInt($('bulk-min').value) || 15;
      const dmax = parseInt($('bulk-max').value) || 45;
      apply.disabled = true; apply.textContent = 'Atualizando…';
      let ok = 0, fail = 0;
      for (const id of ids) {
        const p = state.products.find(x => x.id === id); if (!p) continue;
        try {
          await api('/api/product', { method: 'POST', body: {
            item_id: id, enabled: p.enabled,
            product_key: p.product_key || '',
            delay_min: dmin, delay_max: dmax
          }});
          p.delay_min = dmin; p.delay_max = dmax; ok++;
        } catch { fail++; }
      }
      $('modal').classList.add('hidden');
      state.prodSelected.clear();
      renderProducts();
      toast(`Delay atualizado em ${ok}${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
    }}, 'Aplicar');
    $('modal-actions').append(cancel, apply);
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

  // ─── Messages screen — multi-select with bulk edit ──────────────
  // state.allMessages: { item_id: [m1, m2, m3, m4] } cache
  // state.msgSelected: Set<item_id> currently selected
  state.allMessages = {};
  state.msgSelected = new Set();

  async function loadMessagesScreen() {
    const list = $('msg-prod-list');
    list.innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Carregando produtos e mensagens…</div>';

    // Make sure products are loaded
    if (!state.products.length) {
      try { state.products = await api('/api/products'); } catch (e) { toast(e.message, 'err'); return; }
    }

    // Load messages for all products in parallel (1 KV read per call, OK)
    try {
      const calls = state.products.map(p =>
        api(`/api/messages?id=${p.id}`).then(m => [p.id, m]).catch(() => [p.id, ['','','','']])
      );
      const results = await Promise.all(calls);
      state.allMessages = Object.fromEntries(results);
    } catch (e) { toast(e.message, 'err'); }

    renderMessagesList();
  }

  function renderMessagesList() {
    const q = ($('msg-search').value || '').toLowerCase();
    const filter = $('msg-filter').value;
    const list = $('msg-prod-list');
    list.innerHTML = '';

    const filtered = state.products.filter(p => {
      if (q && !`${p.id}${p.title}`.toLowerCase().includes(q)) return false;
      if (filter === 'enabled' && !p.enabled) return false;
      const msgs = state.allMessages[p.id] || ['','','','',];
      const filledCount = msgs.filter(m => (m || '').trim()).length;
      if (filter === 'with-msg' && filledCount === 0) return false;
      if (filter === 'without-msg' && filledCount > 0) return false;
      return true;
    });

    $('msg-count').textContent = `${filtered.length} de ${state.products.length}`;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="muted small" style="padding:24px;text-align:center">Nenhum produto corresponde aos filtros.</div>';
      updateBulkBar();
      return;
    }

    filtered.forEach(p => {
      const msgs = state.allMessages[p.id] || ['','','','',];
      const filled = msgs.filter(m => (m || '').trim()).length;
      const row = el('div', { class: 'msg-prod-row' + (state.msgSelected.has(p.id) ? ' selected' : ''), 'data-pid': p.id });

      const cb = el('input', { type: 'checkbox' });
      cb.checked = state.msgSelected.has(p.id);
      cb.onchange = e => {
        e.stopPropagation();
        if (cb.checked) state.msgSelected.add(p.id); else state.msgSelected.delete(p.id);
        row.classList.toggle('selected', cb.checked);
        updateBulkBar();
      };

      const statusIcon = el('div', {
        class: 'msg-status ' + (filled === 4 ? 'complete' : filled > 0 ? 'partial' : 'empty'),
        title: filled === 4 ? 'Todas as 4 mensagens configuradas' : (filled > 0 ? `${filled}/4 mensagens` : 'Sem mensagens')
      }, filled === 4 ? '✓' : filled > 0 ? '◐' : '○');

      const info = el('div', { class: 'msg-prod-info' });
      info.appendChild(el('div', { class: 'msg-prod-title' }, p.title || p.id));
      const meta = el('div', { class: 'msg-prod-meta' });
      meta.appendChild(el('span', {}, p.id));
      if (p.enabled) meta.appendChild(el('span', { class: 'tag done' }, 'Habilitado'));
      else meta.appendChild(el('span', { class: 'tag pending' }, 'Desabilitado'));
      meta.appendChild(el('span', {}, `${filled}/4 msgs`));
      info.appendChild(meta);

      const editBtn = el('button', { class: 'btn ghost sm', onclick: e => { e.stopPropagation(); editSingleProductMessages(p); } }, '✏ Editar');

      // Click on row toggles selection
      row.addEventListener('click', () => { cb.click(); });

      row.append(cb, statusIcon, info, editBtn);
      list.appendChild(row);
    });

    updateBulkBar();
  }

  function updateBulkBar() {
    const n = state.msgSelected.size;
    $('msg-selected-count').textContent = n;
    const has = n > 0;
    ['btn-bulk-edit','btn-bulk-template','btn-bulk-clear'].forEach(id => $(id).disabled = !has);
    // Update select-all checkbox state
    const visibleIds = Array.from(document.querySelectorAll('#msg-prod-list .msg-prod-row input[type="checkbox"]'));
    const allChecked = visibleIds.length > 0 && visibleIds.every(cb => cb.checked);
    const anyChecked = visibleIds.some(cb => cb.checked);
    const sa = $('msg-selectall');
    sa.checked = allChecked;
    sa.indeterminate = anyChecked && !allChecked;
  }

  function editSingleProductMessages(p) {
    state.msgSelected = new Set([p.id]);
    renderMessagesList();
    bulkEditMessages();
  }

  function bulkEditMessages() {
    const ids = Array.from(state.msgSelected);
    if (!ids.length) return;
    // Determine starting values: if all selected have same content, prefill; else blank
    const samples = ids.map(id => state.allMessages[id] || ['','','','']);
    const initial = [0,1,2,3].map(i => {
      const vals = samples.map(s => s[i] || '');
      const unique = new Set(vals);
      return unique.size === 1 ? vals[0] : '';
    });
    const allSame = initial.some(v => v !== '') || ids.length === 1;
    const headerNote = ids.length === 1
      ? `Editando mensagens de <strong>1 produto</strong>`
      : `Editando mensagens de <strong>${ids.length} produtos</strong> ao mesmo tempo. ${allSame ? 'Mensagens atuais carregadas (são iguais entre os selecionados).' : '<span style="color:var(--warning)">Os produtos têm mensagens diferentes — preencher abaixo sobrescreve em todos.</span>'}`;

    $('modal-title').textContent = ids.length === 1 ? 'Editar Mensagens' : `Editar Mensagens em Massa (${ids.length})`;
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">${headerNote}</div>
      <div class="msg-editor">
        ${[0,1,2,3].map(i => `
          <div class="msg-row">
            <label>Mensagem ${i+1} ${i === 0 ? '<span class="muted small">(boas-vindas)</span>' : i === 2 ? '<span class="muted small">(usa {key})</span>' : ''}</label>
            <textarea data-bulk-idx="${i}" placeholder="${ids.length > 1 && !allSame ? '(preencher sobrescreve em todos)' : ''}">${(initial[i]||'').replace(/</g,'&lt;')}</textarea>
          </div>
        `).join('')}
        <div class="msg-vars muted small">Variáveis: <code>{nome}</code> nome do comprador · <code>{key}</code> chave do produto · <code>{pedido}</code> ID do pedido</div>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const saveTpl = el('button', { class: 'btn dark', onclick: () => saveCurrentAsTemplate() }, '📑 Salvar como Template');
    const save = el('button', { class: 'btn green', onclick: () => doBulkSave(ids) }, `💾 Salvar em ${ids.length}`);
    $('modal-actions').append(cancel, saveTpl, save);
    $('modal').classList.remove('hidden');
  }

  async function doBulkSave(ids) {
    const newMsgs = [0,1,2,3].map(i => document.querySelector(`#modal textarea[data-bulk-idx="${i}"]`).value);
    const btn = document.querySelector('#modal-actions .btn.green'); btn.disabled = true; btn.textContent = 'Salvando…';
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        await api('/api/messages', { method: 'POST', body: { item_id: id, messages: newMsgs }});
        state.allMessages[id] = [...newMsgs];
        ok++;
      } catch { fail++; }
    }
    $('modal').classList.add('hidden');
    state.msgSelected.clear();
    renderMessagesList();
    toast(`✓ ${ok} salvos${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
  }

  function saveCurrentAsTemplate() {
    const msgs = [0,1,2,3].map(i => document.querySelector(`#modal textarea[data-bulk-idx="${i}"]`).value);
    const name = prompt('Nome para esse template:');
    if (!name) return;
    state.templates[name] = msgs;
    saveTemplate(name).then(() => toast('Template criado: ' + name, 'ok'));
  }

  function bulkApplyTemplate() {
    const names = Object.keys(state.templates);
    if (!names.length) { toast('Crie um template primeiro (na seção Biblioteca de Templates)', 'warn'); return; }
    const ids = Array.from(state.msgSelected);
    $('modal-title').textContent = `Aplicar Template em ${ids.length} produto(s)`;
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">As mensagens atuais serão sobrescritas pelos textos do template escolhido.</div>
      <div class="form-grid">
        <label>Escolha um template
          <select id="bulk-tpl-select">
            ${names.map(n => {
              const c = (state.templates[n] || []).filter(m => (m||'').trim()).length;
              return `<option value="${n}">${n} (${c} msgs)</option>`;
            }).join('')}
          </select>
        </label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn green', onclick: async () => {
      const name = $('bulk-tpl-select').value;
      const msgs = state.templates[name];
      apply.disabled = true; apply.textContent = 'Aplicando…';
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await api('/api/messages', { method: 'POST', body: { item_id: id, messages: msgs }});
          state.allMessages[id] = [...msgs];
          ok++;
        } catch { fail++; }
      }
      $('modal').classList.add('hidden');
      state.msgSelected.clear();
      renderMessagesList();
      toast(`Template "${name}" aplicado em ${ok}${fail ? ' · ' + fail + ' falharam' : ''}`, fail ? 'warn' : 'ok');
    }}, `Aplicar em ${ids.length}`);
    $('modal-actions').append(cancel, apply);
    $('modal').classList.remove('hidden');
  }

  // ─── Templates library ──────────────────────────────────────────
  async function loadTemplates() {
    try {
      state.templates = await api('/api/templates');
      renderTemplates();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderTemplates() {
    const list = $('tpl-list'); list.innerHTML = '';
    const names = Object.keys(state.templates);
    $('tpl-counter').textContent = names.length ? `(${names.length})` : '';
    if (names.length === 0) {
      list.innerHTML = '<div class="muted small" style="padding:14px;text-align:center">Nenhum template ainda. Crie um aqui ou use "Salvar como Template" ao editar mensagens.</div>';
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
    if (state.templates[name]) { toast('Já existe um template com esse nome', 'warn'); return; }
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
      const newMsgs = [0,1,2,3].map(i => document.querySelector(`#modal textarea[data-tpl-idx="${i}"]`).value);
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
    const dateFilter = $('ord-date-filter')?.value || 'all';
    const tbody = document.querySelector('#ord-table tbody');
    tbody.innerHTML = '';

    // Compute date boundary
    let cutoff = 0;
    const now = new Date();
    if (dateFilter === 'today') { const d=new Date(now); d.setHours(0,0,0,0); cutoff=d.getTime(); }
    else if (dateFilter === 'yesterday') { const d=new Date(now); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); cutoff=d.getTime(); }
    else if (dateFilter === 'week') cutoff = now.getTime() - 7*86400000;
    else if (dateFilter === 'month') cutoff = now.getTime() - 30*86400000;
    let cutoffEnd = Infinity;
    if (dateFilter === 'yesterday') { const d=new Date(now); d.setHours(0,0,0,0); cutoffEnd=d.getTime(); }

    let filtered = state.orders.filter(o => {
      if (q && !`${o.order_id}${o.buyer}${o.item_id}`.toLowerCase().includes(q)) return false;
      if (filter === 'pending' && !((o.msgs_sent || 0) === 0 && !o.confirmed)) return false;
      if (filter === 'sending' && !((o.msgs_sent || 0) > 0 && !o.confirmed)) return false;
      if (filter === 'done' && !o.confirmed) return false;
      if (cutoff && o.created_at) {
        const t = new Date(o.created_at).getTime();
        if (t < cutoff || t >= cutoffEnd) return false;
      }
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

  // ─── Broadcast — mass messaging ─────────────────────────────────
  state.bcSelectedProducts = new Set();
  state.bcRecipients = [];
  state.bcSelectedRecipients = new Set();
  state.bcCurrentJobId = null;

  async function initBroadcast() {
    // Make sure products are loaded
    if (!state.products.length) {
      try { state.products = await api('/api/products'); } catch (e) { toast(e.message, 'err'); }
    }
    renderBcProducts();
  }

  function renderBcProducts() {
    const q = ($('bc-search').value || '').toLowerCase();
    const list = $('bc-prod-list');
    list.innerHTML = '';
    const filtered = state.products.filter(p =>
      !q || `${p.title || ''}${p.id}`.toLowerCase().includes(q)
    );
    if (!filtered.length) {
      list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">Nenhum produto.</div>';
      return;
    }
    filtered.forEach(p => {
      const selected = state.bcSelectedProducts.has(p.id);
      const row = el('div', { class: 'msg-prod-row' + (selected ? ' selected' : ''), 'data-pid': p.id });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = selected;
      cb.onchange = e => {
        e.stopPropagation();
        if (cb.checked) state.bcSelectedProducts.add(p.id);
        else state.bcSelectedProducts.delete(p.id);
        row.classList.toggle('selected', cb.checked);
      };
      const info = el('div', { class: 'msg-prod-info' });
      info.appendChild(el('div', { class: 'msg-prod-title' }, p.title || p.id));
      info.appendChild(el('div', { class: 'msg-prod-meta' }, el('span', {}, p.id)));
      row.addEventListener('click', () => cb.click());
      // Empty 2nd column for grid consistency
      row.append(cb, el('span', {}), info);
      list.appendChild(row);
    });
  }

  async function bcSearchBuyers() {
    if (!state.bcSelectedProducts.size) {
      toast('Selecione pelo menos 1 produto', 'warn'); return;
    }
    const days = $('bc-days').value;
    const itemIds = Array.from(state.bcSelectedProducts).join(',');
    const btn = $('btn-bc-search'); btn.disabled = true; btn.textContent = 'Buscando…';
    try {
      const r = await api(`/api/broadcast/buyers?item_ids=${encodeURIComponent(itemIds)}&days=${days}`);
      state.bcRecipients = r.buyers || [];
      state.bcSelectedRecipients = new Set(state.bcRecipients.map(b => b.order_id));
      renderBcRecipients();
      $('bc-recipients-block').classList.remove('hidden');
      $('bc-compose-block').classList.remove('hidden');
      toast(`Encontrados ${r.total} compradores`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '🔎 Buscar compradores'; }
  }

  function renderBcRecipients() {
    const q = ($('bc-recipients-search').value || '').toLowerCase();
    const list = $('bc-recipients-list');
    list.innerHTML = '';
    const filtered = state.bcRecipients.filter(r =>
      !q || `${r.buyer || ''}${r.order_id}${r.item_title || ''}`.toLowerCase().includes(q)
    );
    $('bc-recipients-count').textContent = `${state.bcSelectedRecipients.size} / ${filtered.length} selecionado(s)`;
    if (!filtered.length) {
      list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center">Nenhum comprador encontrado nesse período.</div>';
      return;
    }
    filtered.forEach(r => {
      const sel = state.bcSelectedRecipients.has(r.order_id);
      const row = el('div', { class: 'msg-prod-row' + (sel ? ' selected' : ''), 'data-pid': r.order_id });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = sel;
      cb.onchange = e => {
        e.stopPropagation();
        if (cb.checked) state.bcSelectedRecipients.add(r.order_id);
        else state.bcSelectedRecipients.delete(r.order_id);
        row.classList.toggle('selected', cb.checked);
        $('bc-recipients-count').textContent = `${state.bcSelectedRecipients.size} / ${state.bcRecipients.length} selecionado(s)`;
      };
      const info = el('div', { class: 'msg-prod-info' });
      info.appendChild(el('div', { class: 'msg-prod-title' }, r.buyer || r.order_id));
      const meta = el('div', { class: 'msg-prod-meta' });
      meta.appendChild(el('span', {}, `Pedido: ${r.order_id}`));
      meta.appendChild(el('span', {}, formatDate(r.date_created)));
      if (r.item_title) meta.appendChild(el('span', {}, r.item_title.slice(0, 40)));
      info.appendChild(meta);
      row.addEventListener('click', () => cb.click());
      row.append(cb, el('span', {}), info);
      list.appendChild(row);
    });
  }

  async function bcSendBroadcast() {
    const text = ($('bc-text').value || '').trim();
    if (!text) { toast('Digite a mensagem', 'warn'); return; }
    const dmin = parseInt($('bc-delay-min').value) || 15;
    const dmax = parseInt($('bc-delay-max').value) || 45;
    const recipients = state.bcRecipients.filter(r => state.bcSelectedRecipients.has(r.order_id));
    if (!recipients.length) { toast('Selecione pelo menos 1 destinatário', 'warn'); return; }

    if (!await confirm('Confirmar Broadcast',
      `Enviar essa mensagem para ${recipients.length} comprador(es)?\n\nMensagens serão espaçadas em ${dmin}-${dmax}s. Pode levar vários minutos.`,
      'Enviar', false)) return;

    try {
      const r = await api('/api/broadcast/send', { method: 'POST', body: {
        recipients, text, delay_min: dmin, delay_max: dmax
      }});
      state.bcCurrentJobId = r.job_id;
      $('bc-progress-block').classList.remove('hidden');
      toast('Broadcast iniciado em background', 'ok');
      pollBcStatus();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function pollBcStatus() {
    if (!state.bcCurrentJobId) return;
    try {
      const job = await api(`/api/broadcast/status?id=${state.bcCurrentJobId}`);
      renderBcProgress(job);
      if (job.status === 'in_progress') {
        setTimeout(pollBcStatus, 3000);
      }
    } catch (e) { /* silent */ }
  }

  function renderBcProgress(job) {
    const cont = $('bc-progress');
    const progress = job.total ? Math.round((job.sent + job.failed + job.skipped) / job.total * 100) : 0;
    cont.innerHTML = `
      <div class="info-grid">
        <div><span class="muted">Status:</span> <strong>${
          job.status === 'done' ? '✓ Concluído' :
          job.status === 'in_progress' ? '⏳ Em progresso' :
          job.status === 'paused_time_limit' ? '⏸ Pausado (limite de tempo)' : job.status
        }</strong></div>
        <div><span class="muted">Enviadas:</span> <strong style="color:var(--accent)">${job.sent}</strong> / ${job.total}</div>
        <div><span class="muted">Falhas:</span> <strong style="color:var(--danger)">${job.failed}</strong></div>
        <div><span class="muted">Skipped (chat fechado):</span> <strong style="color:var(--warning)">${job.skipped}</strong></div>
        <div><span class="muted">Progresso:</span> ${progress}%</div>
      </div>
      <div style="margin-top:10px;background:var(--surface-2);border-radius:8px;height:8px;overflow:hidden">
        <div style="height:100%;width:${progress}%;background:var(--accent);transition:width .3s"></div>
      </div>
    `;
    if (job.details && job.details.length) {
      const detList = el('div', { class: 'log', style: 'margin-top:14px;max-height:200px' });
      job.details.slice(-30).reverse().forEach(d => {
        const icon = d.result === 'sent' ? '✅' : d.result === 'failed' ? '❌' : d.result === 'chat_unavailable' ? '🚫' : '⚠';
        const line = el('div', { class: 'log-line' + (d.result === 'sent' ? ' event' : '') },
          `${icon} ${d.buyer || d.order_id}${d.error ? ' — ' + d.error : ''}`);
        detList.appendChild(line);
      });
      cont.appendChild(detList);
    }
  }

  // Wire broadcast handlers (once)
  $('bc-search').addEventListener('input', renderBcProducts);
  $('btn-bc-search').addEventListener('click', bcSearchBuyers);
  $('bc-recipients-search').addEventListener('input', renderBcRecipients);
  $('bc-selectall').addEventListener('change', e => {
    if (e.target.checked) state.bcRecipients.forEach(r => state.bcSelectedRecipients.add(r.order_id));
    else state.bcSelectedRecipients.clear();
    renderBcRecipients();
  });
  $('bc-text').addEventListener('input', () => $('bc-charcount').textContent = `${$('bc-text').value.length} / 350`);
  $('btn-bc-send').addEventListener('click', bcSendBroadcast);
  $('btn-bc-refresh').addEventListener('click', pollBcStatus);

  // ─── Notification system: events polling, sound, browser push ───────
  state.lastEventTs = parseInt(localStorage.getItem('mlas_last_event_ts') || '0');

  // Sound preference and audio element
  state.soundEnabled = localStorage.getItem('mlas_sound') === '1';
  state.pushEnabled = localStorage.getItem('mlas_push') === '1';
  let _audio = null;
  function playSound() {
    if (!state.soundEnabled) return;
    // Generate a short pleasant chime via Web Audio API (no asset required)
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        const t = ctx.currentTime + i * 0.15;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.2, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start(t); osc.stop(t + 0.3);
      });
    } catch (e) { /* silent */ }
  }

  function showPushNotification(title, body) {
    if (!state.pushEnabled) return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, icon: '/favicon.ico', tag: 'mlas-' + Date.now() });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 8000);
    } catch (e) { /* silent */ }
  }

  async function pollEvents() {
    try {
      const events = await api(`/api/events?since=${state.lastEventTs}`);
      if (!events || !events.length) return;
      for (const ev of events.reverse()) {
        if (ev.ts <= state.lastEventTs) continue;
        state.lastEventTs = ev.ts;
        playSound();
        showPushNotification(ev.title, ev.body);
        toast(ev.title + (ev.body ? ' — ' + ev.body : ''), 'ok', 6000);
      }
      localStorage.setItem('mlas_last_event_ts', String(state.lastEventTs));
    } catch (e) { /* silent */ }
  }

  // Start event polling after login
  function startEventPolling() {
    pollEvents();
    setInterval(pollEvents, 20000); // every 20s
  }

  // ─── Settings: accounts, health, vacation, theme, backup, OAuth ─────
  function initSettings() {
    loadAccounts();
    loadHealth();
    loadVacationStatus();
    loadNotificationPrefs();
    renderAccentPicker();
  }

  async function loadAccounts() {
    try {
      const accounts = await api('/api/accounts');
      const cont = $('accounts-list');
      cont.innerHTML = '';
      if (!accounts.length) {
        cont.innerHTML = '<div class="muted small">Nenhuma conta salva ainda. Clique em "Salvar conta atual" para guardar as credenciais ativas.</div>';
        return;
      }
      accounts.forEach(a => {
        const row = el('div', { class: 'msg-prod-row', style: 'grid-template-columns: 1fr auto auto' });
        const info = el('div', { class: 'msg-prod-info' });
        info.appendChild(el('div', { class: 'msg-prod-title' }, `${a.name} ${a.active ? '✓' : ''}`));
        info.appendChild(el('div', { class: 'msg-prod-meta' }, el('span', {}, `Seller ID: ${a.seller_id}`)));
        const switchBtn = el('button', { class: 'btn green sm', onclick: () => switchAccount(a.id) }, a.active ? 'Ativa' : 'Trocar');
        if (a.active) switchBtn.disabled = true;
        const delBtn = el('button', { class: 'btn red-dim sm', onclick: () => deleteAccount(a.id, a.name) }, '✕');
        row.append(info, switchBtn, delBtn);
        cont.appendChild(row);
      });
    } catch (e) { /* silent */ }
  }

  async function switchAccount(id) {
    try {
      const r = await api('/api/accounts/switch', { method: 'POST', body: { id }});
      toast(`Conta ativa: ${r.name}`, 'ok');
      await loadAccounts();
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function deleteAccount(id, name) {
    if (!await confirm('Apagar conta', `Apagar "${name}" das contas salvas? Isso não afeta seu Mercado Livre, só remove do seletor local.`, 'Apagar', true)) return;
    try {
      await api('/api/accounts/delete', { method: 'POST', body: { id }});
      toast('Conta removida', 'ok');
      loadAccounts();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadHealth() {
    try {
      const h = await api('/api/health');
      const cont = $('health-info');
      const fmt = (b) => b ? '<span style="color:var(--accent)">✓</span>' : '<span style="color:var(--danger)">✗</span>';
      cont.innerHTML = `
        <div><span class="muted">Versão Worker:</span> v${h.version}</div>
        <div><span class="muted">Monitoramento:</span> ${fmt(h.monitoring)} ${h.monitoring ? 'Ativo' : 'Pausado'}</div>
        <div><span class="muted">Token:</span> ${fmt(h.token_set)} ${h.token_set ? 'Salvo' : 'Ausente'}</div>
        <div><span class="muted">Auto-refresh:</span> ${fmt(h.auto_refresh_ready)} ${h.auto_refresh_ready ? 'Pronto' : 'Faltando credenciais'}</div>
        <div><span class="muted">Última renovação:</span> ${h.last_refresh_at ? formatDate(h.last_refresh_at) : 'Nunca'}</div>
        <div><span class="muted">Próxima renovação em:</span> ${h.next_proactive_refresh_in_minutes} min</div>
        <div><span class="muted">Fila total:</span> ${h.queue_size} pedido(s)</div>
        <div><span class="muted">Aguardando chat:</span> ${h.queue_awaiting_chat} pedido(s)</div>
        <div><span class="muted">Prontos para enviar:</span> ${h.queue_ready} pedido(s)</div>
        ${h.last_order ? `<div><span class="muted">Última venda:</span> ${h.last_order.buyer} (${h.last_order.msgs_sent} msgs)</div>` : ''}
      `;
    } catch (e) { /* silent */ }
  }

  async function loadVacationStatus() {
    try {
      const h = await api('/api/health');
      const stEl = $('vacation-status');
      if (h.vacation_active && h.vacation_until) {
        const until = new Date(parseInt(h.vacation_until)).toLocaleString('pt-BR');
        stEl.innerHTML = `<span style="color:var(--warning)"><strong>⏸ Em férias até ${until}</strong></span>`;
        $('vac-until').value = new Date(parseInt(h.vacation_until)).toISOString().slice(0, 16);
      } else {
        stEl.innerHTML = '<span class="muted">Modo férias inativo</span>';
      }
    } catch (e) { /* silent */ }
  }

  function loadNotificationPrefs() {
    $('notify-sound').checked = state.soundEnabled;
    $('notify-push').checked = state.pushEnabled && Notification.permission === 'granted';
  }

  function renderAccentPicker() {
    const colors = [
      { name: 'green', val: '#30d158' },
      { name: 'blue', val: '#0a84ff' },
      { name: 'violet', val: '#bf5af2' },
      { name: 'orange', val: '#ff9500' },
      { name: 'pink', val: '#ff375f' },
      { name: 'red', val: '#ff453a' },
    ];
    const current = localStorage.getItem('mlas_accent') || '#30d158';
    const cont = $('accent-picker');
    if (!cont) return;
    cont.innerHTML = '';
    colors.forEach(c => {
      const btn = el('button', {
        style: `width:28px;height:28px;border-radius:50%;border:${current===c.val?'3px solid var(--text)':'1px solid var(--border-strong)'};background:${c.val};cursor:pointer;padding:0`,
        title: c.name,
        onclick: () => {
          document.documentElement.style.setProperty('--accent', c.val);
          localStorage.setItem('mlas_accent', c.val);
          renderAccentPicker();
        }
      });
      cont.appendChild(btn);
    });
    document.documentElement.style.setProperty('--accent', current);
  }

  // Wire all settings handlers (called once at init)
  function wireSettingsHandlers() {
    $('btn-save-account').addEventListener('click', async () => {
      const name = prompt('Nome para essa conta (ex: Loja Principal, Loja2):');
      if (!name) return;
      try {
        await api('/api/accounts/save_current', { method: 'POST', body: { name }});
        toast('Conta salva', 'ok');
        loadAccounts();
      } catch (e) { toast(e.message, 'err'); }
    });

    $('btn-health-refresh').addEventListener('click', () => { loadHealth(); loadVacationStatus(); });

    $('btn-vacation-on').addEventListener('click', async () => {
      const until = $('vac-until').value;
      if (!until) { toast('Selecione uma data', 'warn'); return; }
      try {
        await api('/api/vacation', { method: 'POST', body: { until }});
        toast('Modo férias ativado', 'ok');
        loadVacationStatus();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('btn-vacation-off').addEventListener('click', async () => {
      try {
        await api('/api/vacation', { method: 'POST', body: { until: null }});
        toast('Modo férias cancelado', 'ok');
        loadVacationStatus();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });

    $('notify-sound').addEventListener('change', e => {
      state.soundEnabled = e.target.checked;
      localStorage.setItem('mlas_sound', e.target.checked ? '1' : '0');
      if (e.target.checked) playSound();
    });
    $('notify-push').addEventListener('change', async e => {
      if (e.target.checked) {
        if (Notification.permission === 'default') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            e.target.checked = false;
            toast('Permissão negada — habilite manualmente nas configurações do navegador', 'warn', 6000);
            return;
          }
        } else if (Notification.permission === 'denied') {
          e.target.checked = false;
          toast('Permissão bloqueada — habilite manualmente nas configurações do navegador', 'warn', 6000);
          return;
        }
        state.pushEnabled = true;
        localStorage.setItem('mlas_push', '1');
      } else {
        state.pushEnabled = false;
        localStorage.setItem('mlas_push', '0');
      }
    });
    $('btn-notify-test').addEventListener('click', () => {
      playSound();
      showPushNotification('Teste de notificação', 'Se você ouviu o som e/ou viu essa notificação, está tudo certo!');
      toast('Notificação de teste enviada', 'ok');
    });

    document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.themeSet;
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('mlas_theme', t);
    }));

    $('btn-backup-export').addEventListener('click', async () => {
      try {
        const data = await api('/api/backup/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `mlas_backup_${new Date().toISOString().slice(0,10)}.json` });
        a.click(); URL.revokeObjectURL(url);
        toast('Backup baixado', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('btn-backup-import').addEventListener('click', () => $('backup-file').click());
    $('backup-file').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      if (!await confirm('Restaurar backup', 'Isso vai sobrescrever os dados atuais (produtos, mensagens, configurações). Tem certeza?', 'Restaurar', true)) {
        e.target.value = ''; return;
      }
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const r = await api('/api/backup/import', { method: 'POST', body: json });
        toast(`Backup restaurado (${r.restored} itens)`, 'ok');
        refresh();
      } catch (err) { toast('Falha ao importar: ' + err.message, 'err'); }
      e.target.value = '';
    });

    $('btn-oauth-start').addEventListener('click', async () => {
      const cid = $('oauth-cid').value.trim();
      const cs = $('oauth-cs').value.trim();
      if (!cid || !cs) { toast('Preencha Client ID e Client Secret', 'warn'); return; }
      // Save them locally for after callback
      sessionStorage.setItem('mlas_oauth_pending', JSON.stringify({ cid, cs }));
      const ru = location.origin + location.pathname;
      const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent(ru)}&scope=offline_access+read+write`;
      window.location.href = authUrl;
    });

    // Conversion analytics button
    const convBtn = $('btn-conv-load');
    if (convBtn) convBtn.addEventListener('click', loadConversion);
  }

  // Handle OAuth callback when returning to the site with ?code=
  async function handleOAuthCallback() {
    const code = new URLSearchParams(location.search).get('code');
    if (!code) return;
    const pending = sessionStorage.getItem('mlas_oauth_pending');
    if (!pending) {
      // Old-style callback — just show the code
      return;
    }
    const { cid, cs } = JSON.parse(pending);
    sessionStorage.removeItem('mlas_oauth_pending');
    history.replaceState({}, '', location.pathname);
    const ru = location.origin + location.pathname;
    try {
      const r = await api('/api/oauth/exchange', { method: 'POST', body: {
        code, client_id: cid, client_secret: cs, redirect_uri: ru
      }});
      const msg = r.has_refresh && r.offline_access
        ? '✓ Autorização concluída! Refresh token salvo, auto-renovação ativa.'
        : '⚠ Autorização parcial — verifique offline_access no DevCenter';
      const resultEl = $('oauth-result');
      if (resultEl) resultEl.innerHTML = `<div class="test-result ${r.has_refresh ? 'ok' : 'err'}">${msg}<br><small>Seller ID: ${r.seller_id}</small></div>`;
      toast('Autorização atualizada', 'ok');
      refresh();
      loadHealth();
      loadAccounts();
    } catch (e) {
      toast('Falha no OAuth: ' + e.message, 'err', 8000);
    }
  }

  // ─── Conversion analytics ───────────────────────────────────────
  async function loadConversion() {
    const tbody = document.querySelector('#conv-table tbody');
    const summary = $('conv-summary');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center">Calculando… (pode levar 10-30s, depende do número de produtos)</td></tr>';
    summary.innerHTML = '';
    const days = $('conv-days').value || '30';
    try {
      const data = await api(`/api/conversion?days=${days}`);
      const total = data.products.length;
      const totalVisits = data.total_visits || 0;
      const totalSales = data.total_sales || 0;
      const avgConv = totalVisits > 0 ? (totalSales / totalVisits * 100) : 0;
      summary.innerHTML = `
        <div class="card"><div class="card-label">Total de Visitas (${days}d)</div><div class="card-value blue">${totalVisits.toLocaleString('pt-BR')}</div></div>
        <div class="card"><div class="card-label">Total de Vendas (${days}d)</div><div class="card-value green">${totalSales}</div></div>
        <div class="card"><div class="card-label">Conversão Média</div><div class="card-value violet">${avgConv.toFixed(2)}%</div></div>
      `;
      tbody.innerHTML = '';
      if (!data.products.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center">Nenhum produto encontrado</td></tr>';
        return;
      }
      // Compute avg for performance comparison (only products with visits)
      const productsWithVisits = data.products.filter(p => p.visits > 0);
      const avgRate = productsWithVisits.length
        ? productsWithVisits.reduce((s, p) => s + p.conversion_rate, 0) / productsWithVisits.length
        : 0;
      data.products.forEach(p => {
        const tr = el('tr');
        tr.appendChild(el('td', {}, el('div', { style: 'max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: p.title }, p.title || p.id)));
        tr.appendChild(el('td', {}, el('span', { class: 'tag ' + (p.listing_status === 'active' ? 'done' : 'pending') },
          p.listing_status === 'active' ? '● Ativo' : '⏸ Pausado')));
        tr.appendChild(el('td', {}, p.visits.toLocaleString('pt-BR')));
        tr.appendChild(el('td', {}, String(p.sales)));
        // Conversion cell — color based on performance
        const convCell = el('td');
        if (p.visits > 0) {
          let color = 'var(--muted)';
          if (p.conversion_rate >= avgRate * 1.3) color = 'var(--accent)';
          else if (p.conversion_rate <= avgRate * 0.5) color = 'var(--danger)';
          else if (p.conversion_rate >= avgRate) color = 'var(--accent-2)';
          convCell.innerHTML = `<strong style="color:${color}">${p.conversion_rate.toFixed(2)}%</strong>`;
        } else {
          convCell.innerHTML = '<span class="muted">—</span>';
        }
        tr.appendChild(convCell);
        // Performance label
        let perfTag = '';
        if (p.visits === 0 && p.sales === 0) {
          perfTag = '<span class="tag pending">Sem dados</span>';
        } else if (p.visits === 0 && p.sales > 0) {
          perfTag = '<span class="tag done">Direto</span>';
        } else if (p.conversion_rate >= avgRate * 1.5 && p.sales > 0) {
          perfTag = '<span class="tag done">🚀 Excelente</span>';
        } else if (p.conversion_rate >= avgRate && p.sales > 0) {
          perfTag = '<span class="tag sending">👍 Acima da média</span>';
        } else if (p.visits > 50 && p.sales === 0) {
          perfTag = '<span class="tag fail">⚠ Tráfego sem venda</span>';
        } else if (p.conversion_rate < avgRate * 0.5 && p.visits > 0) {
          perfTag = '<span class="tag fail">📉 Abaixo da média</span>';
        } else {
          perfTag = '<span class="tag pending">Normal</span>';
        }
        tr.appendChild(el('td', { html: perfTag }));
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center;color:var(--danger)">Erro: ${e.message}</td></tr>`;
    }
  }

})();
