// ML Auto Sender — Web Edition
// Single-page app talking to the Cloudflare Worker

(() => {
  'use strict';

  const DEFAULT_WORKER = 'https://crimson-heart-bac6.michaelvmardegam.workers.dev';
  const PANEL_VERSION = '6.29';

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
  // Safe event binding — never throws if element is missing
  const bind = (id, event, fn) => {
    const elem = document.getElementById(id);
    if (!elem) { console.warn(`[bind] #${id} não encontrado — handler ignorado`); return false; }
    elem.addEventListener(event, fn);
    return true;
  };
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
  // Escape anything that goes into innerHTML (titles, names and errors come
  // from Mercado Livre, buyers or the URL — never trust them as HTML)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @ —
  // buyer names and titles come from outside) gets a leading apostrophe.
  const csvCell = v => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t)) t = "'" + t;
    return `"${t.replace(/"/g, '""')}"`;
  };

  const VARS_HELP = `<div class="msg-vars muted small">Variáveis: <code>{nome}</code> apelido do comprador · <code>{primeiro_nome}</code> primeiro nome · <code>{key}</code> chave do produto · <code>{pedido}</code> número do pedido · <code>{produto}</code> título do anúncio<br>Até 350 caracteres por mensagem (limite do Mercado Livre) — se passar, o sistema divide em duas automaticamente.</div>`;
  // Live character counter under each message box
  function wireCharCounters(selector, attr) {
    document.querySelectorAll(selector).forEach(ta => {
      const out = document.querySelector(`#modal [data-cc="${ta.getAttribute(attr)}"]`);
      const upd = () => {
        if (!out) return;
        const n = ta.value.length;
        out.textContent = n ? `${n}/350${n > 350 ? ' — será dividida' : ''}` : '';
        out.style.color = n > 350 ? 'var(--warning)' : '';
      };
      ta.addEventListener('input', upd); upd();
    });
  }

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
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('mlas_auth') || 'null'); } catch { /* dado corrompido: pede login */ }
  // the field must hold the saved Worker BEFORE the automatic login reads it
  // (before v6.29 a saved Worker other than the default was ignored on reload)
  const _lw = $('login-worker');
  if (_lw) _lw.value = (stored?.worker) || DEFAULT_WORKER;
  if (stored) {
    state.worker = stored.worker || DEFAULT_WORKER;
    state.secret = stored.secret || '';
    if (state.secret) tryLogin(true);
  }

  bind('login-btn', 'click', () => tryLogin(false));
  bind('login-secret', 'keydown', e => { if (e.key === 'Enter') tryLogin(false); });

  async function tryLogin(silent) {
    const worker = $('login-worker').value.trim() || state.worker || DEFAULT_WORKER;
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
    const safe = (label, fn) => {
      try { fn(); }
      catch (e) { console.error(`[initApp] erro em ${label}:`, e); }
    };
    safe('setupNav', setupNav);
    safe('setupTheme', setupTheme);
    safe('setupActions', setupActions);
    safe('setupKeyboard', setupKeyboard);
    safe('setupSidebar', setupSidebar);
    safe('wireSettingsHandlers', wireSettingsHandlers);
    safe('wireBroadcastHandlers', wireBroadcastHandlers);
    safe('wireCreateHandlers', wireCreateHandlers);
    safe('wireAnalyticsHandlers', wireAnalyticsHandlers);
    safe('refresh', refresh);
    safe('startPolling', startPolling);
    safe('accent', () => {
      const savedAccent = localStorage.getItem('mlas_accent');
      if (savedAccent) {
        document.documentElement.style.setProperty('--accent', savedAccent);
        document.documentElement.style.setProperty('--grad-green', `linear-gradient(135deg, ${savedAccent} 0%, ${savedAccent}cc 100%)`);
      }
    });
    safe('handleOAuthCallback', handleOAuthCallback);
  }

  // ─── Theme ──────────────────────────────────────────────────────
  function setupTheme() {
    const saved = localStorage.getItem('mlas_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    bind('theme-toggle', 'click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('mlas_theme', next);
    });
  }

  // ─── Nav ────────────────────────────────────────────────────────
  function setupNav() {
    $$('[data-goto]').forEach(b => b.addEventListener('click', () => switchScreen(b.dataset.goto)));
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => {
      const screen = b.dataset.screen;
      switchScreen(screen);
      if (window.innerWidth <= 768) {
        const sb = $('sidebar');
        if (sb) sb.classList.remove('open');
      }
    }));
  }
  function switchScreen(name) {
    state.currentScreen = name;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    $$('.screen').forEach(s => s.classList.toggle('hidden', s.dataset.screen !== name));
    try {
      if (name === 'produtos' && state.products.length === 0) loadProducts();
      if (name === 'pedidos') loadOrders();
      if (name === 'falhas') loadFails();
      if (name === 'mensagens') { loadTemplates(); loadMessagesScreen(); }
      if (name === 'broadcast') initBroadcast();
      if (name === 'config') initSettings();
      if (name === 'estatisticas') initStats();
      if (name === 'fila') loadQueue();
      if (name === 'conversas') loadInbox();
      if (name === 'clonar') initCloneSection();
      if (name === 'logs') loadFullLogs();
      if (name === 'chaves') initKeysScreen();
      if (name === 'criar') initCreate();
    } catch (e) { console.error(`[switchScreen ${name}]`, e); }
  }

  // ─── Sidebar mobile ─────────────────────────────────────────────
  function setupSidebar() {
    bind('sidebar-open', 'click', () => {
      const sb = $('sidebar'); if (sb) sb.classList.add('open');
    });
    bind('sidebar-close', 'click', () => {
      const sb = $('sidebar'); if (sb) sb.classList.remove('open');
    });
    bind('logout-btn', 'click', async () => {
      if (await confirm('Sair', 'Deseja sair? Você precisará da chave secreta para entrar de novo.', 'Sair')) {
        localStorage.removeItem('mlas_auth');
        location.reload();
      }
    });
  }

  // ─── Actions wiring ─────────────────────────────────────────────
  function setupActions() {
    bind('refresh-btn', 'click', refresh);
    bind('btn-activate', 'click', () => toggleMonitoring(true));
    bind('btn-pause', 'click', () => toggleMonitoring(false));
    bind('btn-checknow', 'click', checkNow);
    bind('btn-zerar', 'click', () => danger('/api/stats/reset', 'Zerar contadores', 'Os contadores serão zerados. Sem efeito nas mensagens.'));
    bind('btn-clearqueue', 'click', () => danger('/api/queue/clear', 'Limpar fila', 'Pedidos pendentes saem da fila e NÃO recebem as mensagens que faltam, nem a confirmação automática. Vendas já confirmadas não são afetadas.'));
    bind('btn-reset', 'click', () => danger('/api/full/reset', 'Reset Total', 'Apaga: contadores, fila, falhas e logs. Credenciais, produtos, mensagens e o histórico de pedidos NÃO são afetados.'));
    bind('btn-clearlog', 'click', () => danger('/api/logs/clear', 'Limpar logs', 'Apaga apenas o histórico de mensagens do log de atividade.'));

    bind('btn-loadprods', 'click', loadProducts);
    bind('btn-prod-csv-export', 'click', exportProductsCSV);
    bind('btn-prod-csv-import', 'click', () => $('prod-csv-file')?.click());
    bind('prod-csv-file', 'change', e => { const f = e.target.files?.[0]; if (f) importProductsCSV(f); e.target.value = ''; });
    bind('btn-log-refresh', 'click', loadFullLogs);
    bind('btn-log-export', 'click', exportLogs);
    bind('log-search', 'input', renderFullLogs);
    bind('log-filter', 'change', renderFullLogs);
    bind('log-autorefresh', 'change', e => { if (e.target.checked) loadFullLogs(); else clearTimeout(state.logTimer); });
    bind('prod-search', 'input', renderProducts);
    bind('prod-filter', 'change', renderProducts);
    bind('prod-selectall', 'change', e => {
      const rows = document.querySelectorAll('#prod-list .prod-row[data-pid]');
      if (e.target.checked) rows.forEach(r => state.prodSelected.add(r.dataset.pid));
      else rows.forEach(r => state.prodSelected.delete(r.dataset.pid));
      renderProducts();
    });
    bind('btn-bulk-enable', 'click', () => bulkProdToggle(true));
    bind('btn-bulk-disable', 'click', () => bulkProdToggle(false));
    bind('btn-bulk-active', 'click', () => bulkListingStatus('active'));
    bind('btn-bulk-pause', 'click', () => bulkListingStatus('paused'));
    bind('btn-bulk-stock', 'click', bulkEditStock);
    bind('btn-bulk-delay', 'click', bulkEditDelay);
    bind('btn-bulk-clear-prod', 'click', () => { state.prodSelected.clear(); renderProducts(); });

    bind('btn-loadords', 'click', loadOrders);
    bind('ord-search', 'input', renderOrders);
    bind('ord-filter', 'change', renderOrders);
    bind('ord-date-filter', 'change', renderOrders);
    bind('btn-export', 'click', exportOrdersCSV);

    bind('btn-loadfail', 'click', loadFails);
    bind('btn-clearfail', 'click', () => danger('/api/failed_messages/clear', 'Limpar falhas', 'A lista de falhas será zerada.'));

    bind('btn-newtpl', 'click', newTemplate);
    bind('btn-loadmsg', 'click', loadMessagesScreen);
    bind('msg-search', 'input', renderMessagesList);
    bind('msg-filter', 'change', renderMessagesList);
    bind('msg-selectall', 'change', e => {
      const rows = document.querySelectorAll('#msg-prod-list .msg-prod-row[data-pid]');
      if (e.target.checked) rows.forEach(r => state.msgSelected.add(r.dataset.pid));
      else rows.forEach(r => state.msgSelected.delete(r.dataset.pid));
      renderMessagesList();
    });
    bind('btn-bulk-edit', 'click', bulkEditMessages);
    bind('btn-bulk-template', 'click', bulkApplyTemplate);
    bind('btn-bulk-clear', 'click', () => { state.msgSelected.clear(); renderMessagesList(); });

    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $$('.tab-content').forEach(c => c.classList.toggle('hidden', c.dataset.tab !== t.dataset.tab));
    }));

    bind('btn-testsend', 'click', testSend);
    bind('btn-retry', 'click', retryOrder);
    bind('btn-savecreds', 'click', saveCreds);
    // Note: oauth-link was removed from HTML (replaced by integrated OAuth in Settings)
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
  // One request brings status, log and new events (was two separate polls).
  async function refresh() {
    try {
      const s = await api(`/api/status?since=${state.lastEventTs || 0}`);
      state.status = s;
      renderStatus(s);
      if (!state.lastEventTs) {
        // first time on this browser: start from "now" (server clock) instead of replaying old events
        state.lastEventTs = s.server_time || Date.now();
        localStorage.setItem('mlas_last_event_ts', String(state.lastEventTs));
      } else if (Array.isArray(s.events) && s.events.length) handleEvents(s.events);
    } catch (e) {
      $('status-text').textContent = e.status === 401 ? 'Chave inválida' : 'Offline';
      $('status-dot').className = 'status-dot red';
    }
  }

  // Polls every 15 s while the tab is visible and every 60 s in the background
  // (each poll is a Worker request + KV reads on the free plan).
  function startPolling() {
    const schedule = () => {
      clearInterval(state.pollHandle);
      state.pollHandle = setInterval(refresh, document.hidden ? 60000 : 15000);
    };
    document.addEventListener('visibilitychange', () => { schedule(); if (!document.hidden) refresh(); });
    schedule();
  }

  function renderStatus(s) {
    const dot = $('status-dot'); const text = $('status-text');
    if (!s.token_set) { dot.className = 'status-dot red'; text.textContent = 'Token ausente'; }
    else if (s.token_problem) { dot.className = 'status-dot red'; text.textContent = 'Token com problema'; }
    else if (s.rate_paused) { dot.className = 'status-dot orange'; text.textContent = 'Rate limit'; }
    else if (s.monitoring) { dot.className = 'status-dot green'; text.textContent = 'Monitorando'; }
    else { dot.className = 'status-dot orange'; text.textContent = s.vacation_until ? 'Em férias' : 'Pausado'; }

    const st = s.stats || {};
    $('stat-orders').textContent = st.orders || 0;
    $('stat-messages').textContent = st.messages || 0;
    $('stat-confirmed').textContent = st.confirmed || 0;
    if ($('stat-queue')) $('stat-queue').textContent = s.queue_size ?? 0;
    state.msgsToday = st.messages || 0;
    $('msgs-today').textContent = `${state.msgsToday} msgs`;
    const warn = $('token-warning');
    if (warn) warn.classList.toggle('hidden', !s.token_problem);

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
    const btn = $('btn-checknow'); if (btn) btn.disabled = true;
    try {
      const r = await api('/api/run', { method: 'POST' });
      if (r.rate_limited) toast('O Mercado Livre pediu uma pausa (rate limit) — tente mais tarde', 'warn', 6000);
      else if (r.recovered) toast(`${r.recovered} venda(s) que não tinham chegado foram encontradas e entraram na fila`, 'ok', 6000);
      else toast('Verificado: nenhuma venda perdida. Mensagens da fila saem em até 1 minuto.', 'ok', 5000);
      refresh();
    } catch (e) { toast(e.message, 'err'); }
    finally { if (btn) btn.disabled = false; }
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

    row.addEventListener('click', e => { if (e.target !== cb) cb.click(); });
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

  // Only the changed field is sent — the Worker merges, so key-stock settings
  // configured in "Chaves" are never wiped by a toggle.
  async function toggleProduct(p, enabled) {
    try {
      await api('/api/product', { method: 'POST', body: { item_id: p.id, enabled, title: p.title || '' } });
      p.enabled = enabled;
      renderProducts();
      toast(`${enabled ? '✓ Habilitado' : '✗ Desabilitado'}: ${(p.title || p.id).slice(0, 40)}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function editProduct(p) {
    $('modal-title').textContent = 'Configurar Produto';
    const pool = (p.key_mode || 'fixed') !== 'fixed';
    $('modal-body').innerHTML = `
      <div class="muted small" style="margin-bottom:12px">${esc(p.title || p.id)}</div>
      <div class="form-grid">
        <label>Chave/Serial <span class="muted small">(usada na variável {key})</span><input id="m-key" value="${esc(p.product_key || '')}" placeholder="Ex: ABC123-XYZ" ${pool ? 'disabled' : ''}></label>
        ${pool ? '<div class="muted small">Este anúncio usa estoque de chaves — configure em <strong>Chaves</strong>.</div>' : ''}
        <label>Estoque atual<input id="m-stock" type="number" value="${typeof p.available_quantity === 'number' ? p.available_quantity : 0}" min="0"></label>
        <label>Intervalo mínimo entre mensagens (segundos)<input type="number" id="m-min" value="${Number(p.delay_min) || 15}" min="0"></label>
        <label>Intervalo máximo entre mensagens (segundos)<input type="number" id="m-max" value="${Number(p.delay_max) || 45}" min="0"></label>
        <div class="muted small">As mensagens saem no ciclo de 1 minuto do sistema: intervalos menores que 60 s viram ~1 minuto.</div>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const save = el('button', { class: 'btn blue', onclick: async () => {
      const newStock = parseInt($('m-stock').value);
      const data = { item_id: p.id, title: p.title || '',
        delay_min: parseInt($('m-min').value) || 15,
        delay_max: parseInt($('m-max').value) || 45 };
      if (!pool) data.product_key = $('m-key').value.trim();
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
    try {
      // one request / one KV write for the whole selection
      await api('/api/products/bulk_update', { method: 'POST', body: { item_ids: ids, patch: { enabled: enable } } });
      ids.forEach(id => { const p = state.products.find(x => x.id === id); if (p) p.enabled = enable; });
      state.prodSelected.clear();
      renderProducts();
      toast(`${enable ? '✓' : '✗'} ${ids.length} produto(s) — ${verb} no app`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
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
      <div class="muted small" style="margin-bottom:12px">Intervalo aleatório entre uma mensagem e a próxima. Recomendação: <strong>30-90s</strong>. As mensagens saem no ciclo de 1 minuto, então valores abaixo de 60 s viram ~1 minuto.</div>
      <div class="form-grid">
        <label>Mínimo (segundos)<input type="number" id="bulk-min" value="30" min="0"></label>
        <label>Máximo (segundos)<input type="number" id="bulk-max" value="90" min="0"></label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn blue', onclick: async () => {
      const dmin = Math.max(0, parseInt($('bulk-min').value) || 0);
      const dmax = Math.max(dmin, parseInt($('bulk-max').value) || dmin);
      apply.disabled = true; apply.textContent = 'Atualizando…';
      try {
        await api('/api/products/bulk_update', { method: 'POST', body: { item_ids: ids, patch: { delay_min: dmin, delay_max: dmax } } });
        ids.forEach(id => { const p = state.products.find(x => x.id === id); if (p) { p.delay_min = dmin; p.delay_max = dmax; } });
        $('modal').classList.add('hidden');
        state.prodSelected.clear();
        renderProducts();
        toast(`Intervalo atualizado em ${ids.length} produto(s)`, 'ok');
      } catch (e) { toast(e.message, 'err'); apply.disabled = false; apply.textContent = 'Aplicar'; }
    }}, 'Aplicar');
    $('modal-actions').append(cancel, apply);
    $('modal').classList.remove('hidden');
  }

  // (Templates library functions are defined once, further below.)

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

    // All messages in ONE request (was one request per listing)
    await loadAllMessages();
    renderMessagesList();
  }

  async function loadAllMessages() {
    try { state.allMessages = await api('/api/messages/all') || {}; }
    catch (e) { toast(e.message, 'err'); }
    return state.allMessages;
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
      row.addEventListener('click', e => { if (e.target !== cb) cb.click(); });

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
            <label>Mensagem ${i+1} ${i === 0 ? '<span class="muted small">(boas-vindas)</span>' : i === 2 ? '<span class="muted small">(usa {key})</span>' : ''} <span class="muted small" data-cc="${i}"></span></label>
            <textarea data-bulk-idx="${i}" placeholder="${ids.length > 1 && !allSame ? '(preencher sobrescreve em todos)' : ''}">${esc(initial[i] || '')}</textarea>
          </div>
        `).join('')}
        ${VARS_HELP}
      </div>
    `;
    wireCharCounters('#modal textarea[data-bulk-idx]', 'data-bulk-idx');
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
    try {
      // one request / one KV write for any number of listings
      await api('/api/messages/bulk', { method: 'POST', body: { item_ids: ids, messages: newMsgs } });
      ids.forEach(id => { state.allMessages[id] = [...newMsgs]; });
      $('modal').classList.add('hidden');
      state.msgSelected.clear();
      renderMessagesList();
      toast(`✓ Mensagens salvas em ${ids.length} produto(s)`, 'ok');
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = `💾 Salvar em ${ids.length}`; }
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
              return `<option value="${esc(n)}">${esc(n)} (${c} msgs)</option>`;
            }).join('')}
          </select>
        </label>
      </div>
    `;
    $('modal-actions').innerHTML = '';
    const cancel = el('button', { class: 'btn ghost', onclick: () => $('modal').classList.add('hidden') }, 'Cancelar');
    const apply = el('button', { class: 'btn green', onclick: async () => {
      const name = $('bulk-tpl-select').value;
      const msgs = state.templates[name] || [];
      apply.disabled = true; apply.textContent = 'Aplicando…';
      try {
        await api('/api/messages/bulk', { method: 'POST', body: { item_ids: ids, messages: msgs } });
        ids.forEach(id => { state.allMessages[id] = [...msgs]; });
        $('modal').classList.add('hidden');
        state.msgSelected.clear();
        renderMessagesList();
        toast(`Template "${name}" aplicado em ${ids.length} produto(s)`, 'ok');
      } catch (e) { toast(e.message, 'err'); apply.disabled = false; apply.textContent = `Aplicar em ${ids.length}`; }
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
            <label>Mensagem ${i+1} <span class="muted small" data-cc="${i}"></span></label>
            <textarea data-tpl-idx="${i}">${esc(msgs[i] || '')}</textarea>
          </div>
        `).join('')}
        ${VARS_HELP}
      </div>
    `;
    wireCharCounters('#modal textarea[data-tpl-idx]', 'data-tpl-idx');
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
      if (q && !`${o.order_id}${o.buyer}${o.item_id}${o.title || ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'pending' && !((o.msgs_sent || 0) === 0 && !o.confirmed && !o.skipped)) return false;
      if (filter === 'sending' && !((o.msgs_sent || 0) > 0 && !o.confirmed && !o.skipped)) return false;
      if (filter === 'done' && !o.confirmed) return false;
      if (filter === 'skipped' && !o.skipped) return false;
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
    const SKIP = {
      manual: ['pending', '⏭ Você já tinha conversado'], no_messages: ['pending', '⚠ Anúncio sem mensagens'],
      no_key: ['fail', '🔑 Sem chave no estoque'], chat_blocked: ['fail', '🚫 Chat bloqueado'],
      no_chat: ['fail', '🚫 Chat não abriu'], claim_active: ['fail', '⚠ Reclamação aberta'],
      auth: ['fail', '🔴 Problema de token'], network: ['fail', '⚠ Falha de rede'],
    };
    filtered.forEach(o => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, o.order_id));
      tr.appendChild(el('td', { title: o.title || '' }, o.item_id || '—'));
      tr.appendChild(el('td', {}, o.buyer || '—'));
      tr.appendChild(el('td', {}, o.total_msgs ? `${o.msgs_sent || 0}/${o.total_msgs}` : `${o.msgs_sent || 0} enviadas`));
      let status;
      if (o.confirmed) status = ['done', '✓ Confirmado'];
      else if (o.skipped) status = SKIP[o.skipped] || ['pending', `⏭ ${o.skipped}`];
      else if (o.confirm_failed) status = ['fail', '⚠ Confirme no ML'];
      else if (o.stage === 'confirming') status = ['sending', '✔ Confirmando'];
      else if (o.stage === 'waiting_chat') status = ['pending', '⏳ Aguardando chat'];
      else if (o.msgs_sent > 0) status = ['sending', o.in_queue ? '✉ Enviando' : '✉ Enviadas'];
      else status = ['pending', '⏳ Aguardando'];
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
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
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
        tr.appendChild(el('td', { title: f.msg_text || '' }, f.msg_num === '✔' ? 'confirmação' : `${f.msg_num || '?'}`));
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
    if (!await confirm('Reprocessar pedido', `O pedido ${order_id} será buscado de novo no Mercado Livre e TODAS as mensagens serão enviadas outra vez, com as pausas normais. Continuar?`, 'Reprocessar')) return;
    const btn = $('btn-retry'); if (btn) btn.disabled = true;
    try {
      const r = await api('/api/order/retry', { method: 'POST', body: { order_id }});
      toast(r.message || 'Pedido na fila', 'ok', 6000);
      $('retry-order').value = '';
    } catch (e) { toast(e.data?.message || e.message, 'err', 7000); }
    finally { if (btn) btn.disabled = false; }
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

  // Desempenho do envio automático — últimas vendas registradas pelo Worker
  // (a análise de vendas completa fica no módulo ANÁLISE DE VENDAS, no fim)
  async function renderStats() {
    try {
      const orders = await api('/api/orders');
      state.orders = orders;
      const done = orders.filter(o => Number(o.total_msgs) > 0 && !o.in_queue);
      const planned = done.reduce((t, o) => t + Number(o.total_msgs), 0);
      const sent = done.reduce((t, o) => t + Math.min(Number(o.msgs_sent || 0), Number(o.total_msgs)), 0);
      $('kpi-success').textContent = planned ? Math.round(sent / planned * 100) + '%' : '—';
      const confirmed = orders.filter(o => o.confirmed).length;
      $('kpi-conv').textContent = orders.length ? Math.round(confirmed / orders.length * 100) + '%' : '—';
      // tempo real entre a venda entrar na fila e a 1ª mensagem sair
      const timed = orders.filter(o => Number(o.first_msg_ms) > 0);
      if (timed.length) {
        const avgMs = timed.reduce((t, o) => t + Number(o.first_msg_ms), 0) / timed.length;
        $('kpi-avg').textContent = avgMs < 60000 ? `${Math.round(avgMs / 1000)}s` : `${(avgMs / 60000).toFixed(1)}min`;
      } else $('kpi-avg').textContent = '—';
      const note = $('kpi-sample');
      if (note) note.textContent = orders.length ? `Baseado nas últimas ${orders.length} vendas registradas pelo envio automático.` : 'Ainda não há vendas registradas pelo envio automático.';
    } catch (e) { /* silencioso: a análise de vendas acima continua funcionando */ }
  }

  // "Sobre o Sistema" (Configurações)
  async function loadAbout() {
    if ($('info-worker')) $('info-worker').textContent = state.worker;
    try {
      const ping = await fetch(state.worker.replace(/\/$/, '') + '/ping').then(r => r.json());
      if ($('info-version')) $('info-version').textContent = 'v' + (ping.v || '?') + (ping.v === PANEL_VERSION ? '' : ` (painel v${PANEL_VERSION} — atualize os dois juntos)`);
    } catch { if ($('info-version')) $('info-version').textContent = '—'; }
    if ($('info-panel')) $('info-panel').textContent = 'v' + PANEL_VERSION;
  }

  // ─── OAuth callback handling ────────────────────────────────────
  // Page loaded with ?code= but no pending in-app authorization (e.g. the
  // flow was started elsewhere): show the code as TEXT — never as HTML.
  // Before v6.28 the raw URL value went into innerHTML and an inline onclick,
  // so a crafted link could run code with the panel's secret in reach.
  (() => {
    const code = new URLSearchParams(location.search).get('code');
    if (!code || sessionStorage.getItem('mlas_oauth_pending')) return;
    setTimeout(() => {
      if (sessionStorage.getItem('mlas_oauth_pending')) return;
      const valid = /^TG-[A-Za-z0-9-]{10,200}$/.test(code);
      const body = el('div');
      body.appendChild(el('p', {}, valid
        ? 'O Mercado Livre devolveu um código de autorização, mas a autorização não foi iniciada por este painel. Para concluir, vá em Configurações → OAuth Mercado Livre e clique em "Iniciar autorização".'
        : 'O endereço contém um código que não parece vir do Mercado Livre. Ele foi ignorado.'));
      if (valid) {
        body.appendChild(el('p', { style: 'background:var(--surface-2);padding:10px;border-radius:8px;font-family:monospace;word-break:break-all;font-size:11px' }, code));
        body.appendChild(el('button', { class: 'btn ghost sm', onclick: () => copy(code) }, '📋 Copiar código'));
      }
      history.replaceState({}, '', location.pathname);
      confirmNode(valid ? 'Código recebido' : 'Código inválido', body, 'OK');
    }, 800);
  })();

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
    // a broadcast keeps running on the server after the panel is closed — show it again
    try {
      const jobs = await api('/api/broadcast/status');
      const running = (jobs || []).find(j => j.status === 'in_progress');
      if (running) { state.bcCurrentJobId = running.id; $('bc-progress-block').classList.remove('hidden'); pollBcStatus(); }
    } catch { /* silent */ }
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
      row.addEventListener('click', e => { if (e.target !== cb) cb.click(); });
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
      row.addEventListener('click', e => { if (e.target !== cb) cb.click(); });
      row.append(cb, el('span', {}), info);
      list.appendChild(row);
    });
  }

  async function bcSendBroadcast() {
    const text = ($('bc-text').value || '').trim();
    if (!text) { toast('Digite a mensagem', 'warn'); return; }
    const dmin = Math.max(60, parseInt($('bc-delay-min').value) || 60);
    const dmax = Math.max(dmin, parseInt($('bc-delay-max').value) || 120);
    const recipients = state.bcRecipients.filter(r => state.bcSelectedRecipients.has(r.order_id));
    if (!recipients.length) { toast('Selecione pelo menos 1 destinatário', 'warn'); return; }
    if (recipients.length > 300) { toast('Máximo de 300 destinatários por broadcast (limite de gravações do plano gratuito)', 'warn', 6000); return; }
    const etaMin = Math.ceil(recipients.length * (dmin + dmax) / 2 / 60);

    if (!await confirm('Confirmar Broadcast',
      `Enviar essa mensagem para ${recipients.length} comprador(es)?\n\nO envio acontece em segundo plano, cerca de 1 mensagem a cada ${Math.round((dmin + dmax) / 2 / 60 * 10) / 10} min — leva uns ${etaMin} min no total. Você pode fechar o painel.`,
      'Enviar', false)) return;

    try {
      const r = await api('/api/broadcast/send', { method: 'POST', body: {
        recipients, text, delay_min: dmin, delay_max: dmax
      }});
      state.bcCurrentJobId = r.job_id;
      $('bc-progress-block').classList.remove('hidden');
      toast('Broadcast na fila — a primeira mensagem sai em até 1 minuto', 'ok', 5000);
      pollBcStatus();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function pollBcStatus() {
    if (!state.bcCurrentJobId) return;
    clearTimeout(state.bcTimer);
    try {
      const job = await api(`/api/broadcast/status?id=${encodeURIComponent(state.bcCurrentJobId)}`);
      renderBcProgress(job);
      if (job.status === 'in_progress' && state.currentScreen === 'broadcast') state.bcTimer = setTimeout(pollBcStatus, 20000);
    } catch (e) { /* silent */ }
  }

  async function bcCancel() {
    if (!state.bcCurrentJobId) return;
    if (!await confirm('Cancelar broadcast', 'As mensagens que ainda não saíram não serão enviadas.', 'Cancelar broadcast', true)) return;
    try { await api('/api/broadcast/cancel', { method: 'POST', body: { id: state.bcCurrentJobId } }); toast('Cancelamento pedido — para em até 1 minuto', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  }

  function renderBcProgress(job) {
    const cont = $('bc-progress');
    const progress = job.total ? Math.round((job.sent + job.failed + job.skipped) / job.total * 100) : 0;
    const label = { done: '✓ Concluído', in_progress: '⏳ Enviando (1 por minuto)', cancelled: '⏹ Cancelado',
      paused_account: '⏸ Interrompido (a conta ativa mudou)' }[job.status] || job.status;
    const left = Math.max(0, (job.total || 0) - (job.idx || 0));
    cont.innerHTML = `
      <div class="info-grid">
        <div><span class="muted">Status:</span> <strong>${esc(label)}</strong></div>
        <div><span class="muted">Enviadas:</span> <strong style="color:var(--accent)">${job.sent}</strong> / ${job.total}</div>
        <div><span class="muted">Falhas:</span> <strong style="color:var(--danger)">${job.failed}</strong></div>
        <div><span class="muted">Chat fechado:</span> <strong style="color:var(--warning)">${job.skipped}</strong></div>
        <div><span class="muted">Progresso:</span> ${progress}%${job.status === 'in_progress' && left ? ` · faltam ~${Math.ceil(left * ((job.delay_min || 60) + (job.delay_max || 60)) / 120)} min` : ''}</div>
      </div>
      <div style="margin-top:10px;background:var(--surface-2);border-radius:8px;height:8px;overflow:hidden">
        <div style="height:100%;width:${progress}%;background:var(--accent);transition:width .3s"></div>
      </div>
    `;
    if (job.status === 'in_progress') cont.appendChild(el('button', { class: 'btn ghost sm', style: 'margin-top:10px', onclick: bcCancel }, '⏹ Cancelar broadcast'));
    if (job.note) cont.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' }, job.note));
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

  // Wire broadcast handlers — called from initApp, uses safe bind
  function wireBroadcastHandlers() {
    bind('bc-search', 'input', renderBcProducts);
    bind('btn-bc-search', 'click', bcSearchBuyers);
    bind('bc-recipients-search', 'input', renderBcRecipients);
    bind('bc-selectall', 'change', e => {
      if (e.target.checked) state.bcRecipients.forEach(r => state.bcSelectedRecipients.add(r.order_id));
      else state.bcSelectedRecipients.clear();
      renderBcRecipients();
    });
    bind('bc-text', 'input', () => {
      const cc = $('bc-charcount'), txt = $('bc-text');
      if (cc && txt) cc.textContent = `${txt.value.length} / 350`;
    });
    bind('btn-bc-send', 'click', bcSendBroadcast);
    bind('btn-bc-refresh', 'click', pollBcStatus);
  }

  // ─── Notification system: events (ride along with the status poll), sound, push ───
  state.lastEventTs = parseInt(localStorage.getItem('mlas_last_event_ts') || '0') || 0;

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

  function handleEvents(events) {
    let changed = false;
    for (const ev of [...events].reverse()) {
      if (!ev || ev.ts <= state.lastEventTs) continue;
      state.lastEventTs = ev.ts; changed = true;
      playSound();
      showPushNotification(ev.title, ev.body);
      toast(ev.title + (ev.body ? ' — ' + ev.body : ''), 'ok', 6000);
    }
    if (changed) localStorage.setItem('mlas_last_event_ts', String(state.lastEventTs));
  }

  // ─── Settings: accounts, health, vacation, theme, backup, OAuth ─────
  function initSettings() {
    loadAccounts();
    loadHealth();
    loadNotificationPrefs();
    renderAccentPicker();
    loadAIConfig();
    loadQuickReplies();
    loadTelegram();
    loadAbout();
    const ru = $('oauth-ru');
    if (ru && !ru.value) ru.value = localStorage.getItem('mlas_oauth_ru') || defaultRedirectUri();
  }

  // Redirect URI registered in the ML DevCenter. The old helper pages used the
  // site address WITHOUT the trailing slash; ML requires an exact match.
  function defaultRedirectUri() {
    return (location.origin + location.pathname).replace(/\/(index\.html)?$/, '');
  }

  // ─── Clone listings between accounts ────────────────────────────
  state.cloneSelected = new Set();

  async function initCloneSection() {
    // Populate target account dropdown
    try {
      const accounts = await api('/api/accounts');
      const sel = $('clone-target');
      if (sel) {
        const others = accounts.filter(a => !a.active);
        sel.innerHTML = others.length
          ? others.map(a => `<option value="${esc(a.id)}">${esc(a.name)} (${esc(a.seller_id)})</option>`).join('')
          : '<option value="">Nenhuma outra conta salva</option>';
      }
    } catch (e) { /* silent */ }
    // Load products of active account
    if (!state.products.length) {
      try { state.products = await api('/api/products'); } catch (e) {}
    }
    renderCloneProducts();
    // resume showing a job that is still running (it runs on the server)
    try {
      const jobs = await api('/api/listings/clone/status');
      const running = (jobs || []).find(j => j.status === 'in_progress') || (jobs || [])[0];
      if (running && !state.cloneJobId) { state.cloneJobId = running.id; pollCloneStatus(); }
    } catch { /* silent */ }
  }

  function renderCloneProducts() {
    const cont = $('clone-prod-list');
    if (!cont) return;
    const q = ($('clone-search')?.value || '').toLowerCase();
    const filtered = state.products.filter(p =>
      !q || `${p.title || ''}${p.id}`.toLowerCase().includes(q));
    cont.innerHTML = '';
    if (!filtered.length) {
      cont.innerHTML = '<div class="muted small" style="padding:16px;text-align:center">Nenhum anúncio.</div>';
      return;
    }
    filtered.forEach(p => {
      const sel = state.cloneSelected.has(p.id);
      const row = el('div', { class: 'msg-prod-row' + (sel ? ' selected' : ''), 'data-pid': p.id });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = sel;
      cb.onchange = e => {
        e.stopPropagation();
        if (cb.checked) state.cloneSelected.add(p.id); else state.cloneSelected.delete(p.id);
        row.classList.toggle('selected', cb.checked);
      };
      const info = el('div', { class: 'msg-prod-info' });
      info.appendChild(el('div', { class: 'msg-prod-title' }, p.title || p.id));
      info.appendChild(el('div', { class: 'msg-prod-meta' }, el('span', {}, p.id)));
      row.addEventListener('click', e => { if (e.target !== cb) cb.click(); });
      row.append(cb, el('span', {}), info);
      cont.appendChild(row);
    });
  }

  async function startClone() {
    const targetId = $('clone-target')?.value;
    if (!targetId) { toast('Selecione uma conta destino', 'warn'); return; }
    const ids = Array.from(state.cloneSelected);
    if (!ids.length) { toast('Selecione ao menos 1 anúncio', 'warn'); return; }
    const mode = $('clone-mode')?.value || 'paused';
    if (!await confirm('Clonar anúncios',
      `Vai clonar ${ids.length} anúncio(s) para a conta selecionada, criados como "${mode === 'active' ? 'ATIVO' : 'pausado'}".\n\nO sistema cria 1 anúncio por minuto em segundo plano (uns ${ids.length} min no total) — pode fechar o painel.\n\nLembre: o ML pode penalizar catálogo duplicado. Revise os anúncios clonados antes de divulgar.`,
      'Clonar', mode === 'active')) return;
    try {
      const r = await api('/api/listings/clone', { method: 'POST', body: {
        item_ids: ids, target_account_id: targetId, mode
      }});
      state.cloneJobId = r.job_id;
      toast('Clonagem na fila — o primeiro anúncio sai em até 1 minuto', 'ok', 5000);
      pollCloneStatus();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function pollCloneStatus() {
    if (!state.cloneJobId) return;
    clearTimeout(state.cloneTimer);
    try {
      const job = await api(`/api/listings/clone/status?id=${encodeURIComponent(state.cloneJobId)}`);
      const cont = $('clone-progress');
      if (cont) {
        const pct = job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0;
        const label = { done: '✓ Concluído', in_progress: '⏳ Clonando (1 por minuto)', cancelled: '⏹ Cancelado',
          error: '❌ Parado', paused_account: '⏸ Interrompido (a conta ativa mudou)' }[job.status] || job.status;
        cont.innerHTML = `
          <div class="info-grid">
            <div><span class="muted">Status:</span> <strong>${esc(label)}</strong></div>
            <div><span class="muted">Clonados:</span> <strong style="color:var(--accent)">${job.done}</strong>/${job.total}</div>
            <div><span class="muted">Falhas:</span> <strong style="color:var(--danger)">${job.failed}</strong></div>
          </div>
          <div style="margin-top:8px;background:var(--surface-2);border-radius:8px;height:8px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:var(--accent);transition:width .3s"></div>
          </div>`;
        if (job.note) cont.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px;color:var(--warning)' }, job.note));
        if (job.status === 'in_progress') cont.appendChild(el('button', { class: 'btn ghost sm', style: 'margin-top:8px', onclick: async () => {
          if (!await confirm('Cancelar clonagem', 'Os anúncios que ainda não foram criados não serão clonados.', 'Cancelar clonagem', true)) return;
          try { await api('/api/listings/clone/cancel', { method: 'POST', body: { id: job.id } }); toast('Cancelamento pedido', 'ok'); } catch (e) { toast(e.message, 'err'); }
        } }, '⏹ Cancelar'));
        if (job.details && job.details.length) {
          const log = el('div', { class: 'log', style: 'margin-top:12px;max-height:220px' });
          job.details.slice(-30).reverse().forEach(d => {
            const icon = d.result === 'clonado' ? '✅' : '❌';
            const line = el('div', { class: 'log-line' }, `${icon} ${String(d.title || d.item_id).slice(0, 45)}${d.new_id ? ' → ' + d.new_id + (d.status === 'paused' ? ' (pausado)' : '') : ''}${d.error ? ' — ' + d.error : ''}${d.warning ? ' ⚠ ' + d.warning : ''}`);
            log.appendChild(line);
          });
          cont.appendChild(log);
        }
      }
      if (job.status === 'in_progress') { if (state.currentScreen === 'clonar') state.cloneTimer = setTimeout(pollCloneStatus, 15000); }
      else { state.cloneSelected.clear(); renderCloneProducts(); }
    } catch (e) { /* silent */ }
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
      // Rate limit status
      let rateLimitRow = '';
      if (h.rate_until) {
        const rUntil = new Date(parseInt(h.rate_until));
        const minsLeft = Math.ceil((parseInt(h.rate_until) - Date.now()) / 60000);
        if (minsLeft > 0) {
          rateLimitRow = `
            <div style="grid-column:1/-1;background:rgba(255,159,10,.12);padding:10px;border-radius:8px;margin:8px 0">
              <div><span class="muted">⏸ Rate limit ativo:</span> <strong style="color:var(--warning)">${minsLeft} min restantes</strong> (até ${rUntil.toLocaleTimeString('pt-BR')})</div>
              <button class="btn dark sm" id="btn-clear-ratelimit" style="margin-top:6px">▶ Limpar rate limit</button>
              <div class="muted small" style="margin-top:4px">⚠ Use só se necessário. Limpar manualmente e voltar a enviar pode disparar novo bloqueio pelo ML.</div>
            </div>`;
        }
      }
      cont.innerHTML = `
        <div><span class="muted">Versão Worker:</span> v${esc(h.version)}</div>
        <div><span class="muted">Monitoramento:</span> ${fmt(h.monitoring)} ${h.monitoring ? 'Ativo' : (h.vacation_active ? 'Em férias' : 'Pausado')}</div>
        <div><span class="muted">Token:</span> ${fmt(h.token_set && !h.token_problem)} ${!h.token_set ? 'Ausente' : h.token_problem ? 'Renovação falhando — refaça a autorização' : 'OK'}</div>
        <div><span class="muted">Auto-renovação:</span> ${fmt(h.auto_refresh_ready)} ${h.auto_refresh_ready ? 'Pronta' : 'Faltando credenciais'}</div>
        <div><span class="muted">Última renovação:</span> ${h.last_refresh_at ? formatDate(h.last_refresh_at) : 'Nunca'}</div>
        <div><span class="muted">Próxima renovação em:</span> ${Number(h.next_proactive_refresh_in_minutes) || 0} min</div>
        ${rateLimitRow}
        <div><span class="muted">Fila total:</span> ${Number(h.queue_size) || 0} pedido(s)</div>
        <div><span class="muted">Aguardando chat:</span> ${Number(h.queue_awaiting_chat) || 0} pedido(s)</div>
        <div><span class="muted">Prontos para enviar:</span> ${Number(h.queue_ready) || 0} pedido(s)</div>
        ${h.last_order ? `<div><span class="muted">Última venda:</span> ${esc(h.last_order.buyer)} (${Number(h.last_order.msgs_sent) || 0} msgs)</div>` : ''}
      `;
      loadVacationStatus(h);
      // Consumo de operações KV do dia (o recurso escasso do plano gratuito)
      try {
        const u = await api('/api/kv_usage');
        const bar = (used, lim) => {
          const pct = Math.min(100, Math.round(used / lim * 100));
          const cor = pct >= 80 ? 'var(--danger)' : pct >= 50 ? 'var(--warning, #e0a82e)' : 'var(--accent)';
          return `<div style="margin:4px 0">
            <div class="muted small">${used.toLocaleString('pt-BR')} de ${lim.toLocaleString('pt-BR')} (${pct}%)</div>
            <div style="background:var(--surface-2);border-radius:6px;height:6px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${cor}"></div></div></div>`;
        };
        cont.innerHTML += `
          <div style="grid-column:1/-1;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
            <div class="muted small" style="margin-bottom:6px"><strong>Consumo KV hoje</strong> — estimativa do próprio Worker</div>
            <div><span class="muted small">Listagens (limite crítico)</span>${bar(u.lists, u.limits.lists)}</div>
            <div><span class="muted small">Escritas</span>${bar(u.writes, u.limits.writes)}</div>
            <div><span class="muted small">Leituras</span>${bar(u.reads, u.limits.reads)}</div>
          </div>`;
      } catch { /* silent */ }

      // Wire the button if it was rendered
      const clearBtn = $('btn-clear-ratelimit');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (!await confirm('Limpar rate limit',
            'Vai liberar imediatamente o envio de mensagens. ⚠ Se o ML ainda estiver bloqueando, ele pode reaplicar o rate limit por mais tempo. Use só quando realmente necessário.',
            'Limpar agora')) return;
          try {
            await api('/api/rate_limit/clear', { method: 'POST' });
            toast('Rate limit limpo', 'ok');
            loadHealth();
          } catch (e) { toast(e.message, 'err'); }
        });
      }
    } catch (e) { /* silent */ }
  }

  // Uses the health data already loaded (was a second /api/health request)
  async function loadVacationStatus(h) {
    try {
      h = h || await api('/api/health');
      const stEl = $('vacation-status');
      if (h.vacation_active && h.vacation_until) {
        const d = new Date(parseInt(h.vacation_until));
        stEl.innerHTML = `<span style="color:var(--warning)"><strong>⏸ Em férias até ${esc(d.toLocaleString('pt-BR'))}</strong></span>`;
        // datetime-local wants LOCAL time (toISOString() is UTC and showed 3 h off)
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        $('vac-until').value = local;
      } else {
        stEl.innerHTML = '<span class="muted">Modo férias inativo</span>';
      }
    } catch (e) { /* silent */ }
  }

  function loadNotificationPrefs() {
    $('notify-sound').checked = state.soundEnabled;
    $('notify-push').checked = state.pushEnabled && Notification.permission === 'granted';
  }

  function applyAccent(color) {
    document.documentElement.style.setProperty('--accent', color);
    // Also recompute gradient to match
    document.documentElement.style.setProperty('--grad-green', `linear-gradient(135deg, ${color} 0%, ${color}cc 100%)`);
    // Glow for status dot
    document.documentElement.style.setProperty('--accent-glow', color);
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
      const btn = document.createElement('button');
      btn.style.cssText = `width:28px;height:28px;border-radius:50%;border:${current===c.val?'3px solid var(--text)':'1px solid var(--border-strong)'};background:${c.val};cursor:pointer;padding:0`;
      btn.title = c.name;
      btn.onclick = () => {
        applyAccent(c.val);
        localStorage.setItem('mlas_accent', c.val);
        renderAccentPicker();
      };
      cont.appendChild(btn);
    });
    applyAccent(current);
  }

  // Wire all settings handlers (called once at init)
  function wireSettingsHandlers() {
    // Safe binding helper — logs warning instead of crashing if element missing
    const on = (id, ev, fn) => {
      const el = $(id);
      if (!el) { console.warn(`[wireSettingsHandlers] element #${id} not found`); return; }
      el.addEventListener(ev, fn);
    };

    on('btn-save-account', 'click', async () => {
      const name = prompt('Nome para essa conta (ex: Loja Principal, Loja2):');
      if (!name) return;
      try {
        await api('/api/accounts/save_current', { method: 'POST', body: { name }});
        toast('Conta salva', 'ok');
        loadAccounts();
      } catch (e) {
        console.error('Save account error:', e);
        toast('Erro: ' + e.message, 'err', 6000);
      }
    });

    on('btn-health-refresh', 'click', () => loadHealth());

    on('btn-vacation-on', 'click', async () => {
      const raw = $('vac-until').value;
      if (!raw) { toast('Selecione uma data', 'warn'); return; }
      // datetime-local is the user's local time → send an absolute instant
      const d = new Date(raw);
      if (isNaN(d)) { toast('Data inválida', 'warn'); return; }
      try {
        await api('/api/vacation', { method: 'POST', body: { until: d.toISOString() }});
        toast(`Modo férias ativado até ${d.toLocaleString('pt-BR')}`, 'ok');
        loadVacationStatus();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
    on('btn-vacation-off', 'click', async () => {
      try {
        await api('/api/vacation', { method: 'POST', body: { until: null }});
        toast('Modo férias cancelado', 'ok');
        loadVacationStatus();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });

    on('notify-sound', 'change', e => {
      state.soundEnabled = e.target.checked;
      localStorage.setItem('mlas_sound', e.target.checked ? '1' : '0');
      if (e.target.checked) playSound();
    });
    on('notify-push', 'change', async e => {
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
    on('btn-notify-test', 'click', () => {
      playSound();
      showPushNotification('Teste de notificação', 'Se você ouviu o som e/ou viu essa notificação, está tudo certo!');
      toast('Notificação de teste enviada', 'ok');
    });

    document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.themeSet;
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('mlas_theme', t);
      toast(`Tema: ${t === 'dark' ? 'Escuro' : 'Claro'}`, 'ok', 2000);
    }));

    on('btn-backup-export', 'click', async () => {
      try {
        const data = await api('/api/backup/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mlas_backup_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Backup baixado', 'ok');
      } catch (e) {
        console.error('Backup error:', e);
        toast('Erro no backup: ' + e.message, 'err', 6000);
      }
    });
    on('btn-backup-import', 'click', () => $('backup-file')?.click());
    on('backup-file', 'change', async e => {
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

    on('btn-oauth-start', 'click', async () => {
      const cid = $('oauth-cid').value.trim();
      const cs = $('oauth-cs').value.trim();
      const ru = ($('oauth-ru')?.value || '').trim() || defaultRedirectUri();
      if (!cid || !cs) { toast('Preencha Client ID e Client Secret', 'warn'); return; }
      if (!/^\d+$/.test(cid)) { toast('O Client ID tem só números', 'warn'); return; }
      if (!/^https:\/\//.test(ru)) { toast('A Redirect URI precisa começar com https://', 'warn'); return; }
      localStorage.setItem('mlas_oauth_ru', ru);
      // the secret stays only in this tab (sessionStorage) until the code comes back
      sessionStorage.setItem('mlas_oauth_pending', JSON.stringify({ cid, cs, ru }));
      const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(ru)}&scope=offline_access+read+write`;
      window.location.href = authUrl;
    });

    on('btn-conv-load', 'click', loadConversion);
    on('btn-loadqueue', 'click', loadQueue);
    on('btn-clone-start', 'click', startClone);
    on('clone-search', 'input', renderCloneProducts);
    on('btn-load-inbox', 'click', loadInbox);
    on('btn-ai-save', 'click', saveAIConfig);
    on('btn-ai-test', 'click', testAI);
    on('btn-qr-add', 'click', () => { state.quickReplies.push({ label: '', text: '' }); renderQuickRepliesConfig(); });
    on('btn-qr-save', 'click', saveQuickReplies);
    on('btn-tg-connect', 'click', connectTelegram);
    on('btn-tg-test', 'click', async () => {
      try { await api('/api/telegram/test', { method: 'POST' }); toast('Enviado — confira o Telegram', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
    on('btn-tg-off', 'click', async () => {
      if (!await confirm('Desconectar Telegram', 'Os alertas deixam de ser enviados e o token é apagado.', 'Desconectar', true)) return;
      try { await api('/api/telegram', { method: 'POST', body: { clear: true } }); toast('Desconectado', 'ok'); loadTelegram(); }
      catch (e) { toast(e.message, 'err'); }
    });
    on('btn-tg-save', 'click', saveTelegramAlerts);
    on('keys-product', 'change', loadKeys);
    on('keys-mode', 'change', applyKeysModeUI);
    on('btn-keys-reload', 'click', () => { loadKeys(); loadKeysSummary(); });
    on('btn-keys-savemode', 'click', saveKeysMode);
    on('btn-keys-add', 'click', addKeys);
    on('btn-keys-clean', 'click', async () => {
      const itemId = $('keys-product')?.value;
      if (!await confirm('Limpar usadas', 'Remove do histórico as chaves já entregues. As disponíveis não são afetadas.', 'Limpar')) return;
      try { const r = await api('/api/keys/delete', { method: 'POST', body: { item_id: itemId, delete_used: true } });
        toast(`${r.deleted} chave(s) removida(s)`, 'ok'); loadKeys(); }
      catch (e) { toast(e.message, 'err'); }
    });
    on('ai-provider', 'change', () => {
      applyAIProviderUI();
      const prov = $('ai-provider').value;
      const first = (AI_PRESETS[prov] || [])[0];
      if (first) {
        if ($('ai-model')) $('ai-model').value = first.model || '';
        if ($('ai-baseurl') && first.base) $('ai-baseurl').value = first.base;
      }
    });
    on('ai-preset', 'change', e => {
      const prov = $('ai-provider')?.value;
      const pr = (AI_PRESETS[prov] || [])[parseInt(e.target.value)];
      if (!pr) return;
      if ($('ai-model')) $('ai-model').value = pr.model || '';
      if ($('ai-baseurl') && pr.base) $('ai-baseurl').value = pr.base;
    });
    on('btn-ai-addfaq', 'click', () => {
      state.aiFaq.push({ q: '', a: '' });
      renderAIFaq();
    });
    on('clone-selectall', 'change', e => {
      const rows = document.querySelectorAll('#clone-prod-list .msg-prod-row[data-pid]');
      if (e.target.checked) rows.forEach(r => state.cloneSelected.add(r.dataset.pid));
      else rows.forEach(r => state.cloneSelected.delete(r.dataset.pid));
      renderCloneProducts();
    });
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
    let saved = {};
    try { saved = JSON.parse(pending) || {}; } catch { /* ignore */ }
    const { cid, cs } = saved;
    const ru = saved.ru || defaultRedirectUri();
    sessionStorage.removeItem('mlas_oauth_pending');
    history.replaceState({}, '', location.pathname);
    if (!/^TG-[A-Za-z0-9-]{10,200}$/.test(code)) { toast('O código de autorização recebido é inválido. Tente de novo.', 'err', 8000); return; }
    switchScreen('config');
    try {
      const r = await api('/api/oauth/exchange', { method: 'POST', body: {
        code, client_id: cid, client_secret: cs, redirect_uri: ru
      }});
      const ok = r.has_refresh && r.offline_access;
      const resultEl = $('oauth-result');
      if (resultEl) {
        resultEl.innerHTML = '';
        resultEl.appendChild(el('div', { class: `test-result ${r.has_refresh ? 'ok' : 'err'}` },
          ok ? '✓ Autorização concluída! Auto-renovação ativa.' : '⚠ Autorização parcial — ative "offline_access" no DevCenter do Mercado Livre',
          el('br'), el('small', {}, `Seller ID: ${r.seller_id || '?'}`)));
      }
      toast('Autorização atualizada', 'ok');
      refresh();
      loadHealth();
      loadAccounts();
    } catch (e) {
      const hint = /redirect/i.test(e.message) ? ` — a Redirect URI (${ru}) precisa ser idêntica à cadastrada no DevCenter` : '';
      toast('Falha no OAuth: ' + e.message + hint, 'err', 10000);
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
      tbody.innerHTML = `<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center;color:var(--danger)">Erro: ${esc(e.message)}</td></tr>`;
    }
  }

  // ─── Queue management ───────────────────────────────────────────
  async function loadQueue() {
    const tbody = document.querySelector('#queue-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center">Carregando…</td></tr>';
    try {
      const queue = await api('/api/queue/list');
      const count = $('queue-count');
      if (count) count.textContent = `${queue.length} pedido(s) na fila`;
      tbody.innerHTML = '';
      if (!queue.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center">Fila vazia 🎉</td></tr>';
        return;
      }
      const STAGE = {
        waiting_chat: ['pending', '⏳ Aguardando chat'], sending: ['sending', '✉ Enviando'],
        retrying: ['fail', '🔁 Tentando de novo'], confirming: ['done', '✔ Confirmando venda'],
      };
      const fmtIn = ts => {
        if (!ts) return '—';
        const diff = ts - Date.now();
        if (diff <= 0) return 'no próximo minuto';
        if (diff < 60000) return `em ${Math.round(diff / 1000)}s`;
        if (diff < 3600000) return `em ${Math.round(diff / 60000)} min`;
        return `em ${(diff / 3600000).toFixed(1)} h`;
      };
      queue.forEach(q => {
        const tr = el('tr');
        tr.appendChild(el('td', {}, q.is_template ? `Template${q.real_order_id ? ' · ' + q.real_order_id : ''}` : q.order_id));
        const buyerCell = el('td', {}, q.buyer || '—');
        if (q.recovered) buyerCell.appendChild(el('span', { class: 'tag pending', style: 'margin-left:6px' }, '🛟 recuperado'));
        tr.appendChild(buyerCell);
        tr.appendChild(el('td', {}, q.total_msgs ? `${q.msgs_sent}/${q.total_msgs}` : '—'));
        const st = STAGE[q.stage] || ['sending', q.stage || '—'];
        const stCell = el('td', {}, el('span', { class: `tag ${st[0]}` }, st[1]));
        if (q.last_error) stCell.appendChild(el('div', { class: 'muted small', style: 'margin-top:4px' }, q.last_error));
        tr.appendChild(stCell);
        let next = fmtIn(q.hold_until || q.next_send_at);
        if (q.stage === 'waiting_chat') next = 'verificando a cada 5–30 min';
        tr.appendChild(el('td', {}, next));
        const actionsCell = el('td');
        if (q.stage !== 'confirming') {
          actionsCell.appendChild(el('button', { class: 'btn green sm', onclick: () => forceSend(q.order_id, q.buyer) }, '⚡ Forçar envio'));
        }
        tr.appendChild(actionsCell);
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted small" style="padding:20px;text-align:center;color:var(--danger)">Erro: ${esc(e.message)}</td></tr>`;
    }
  }

  async function forceSend(orderId, buyer) {
    if (!await confirm(`Forçar envio: ${buyer || orderId}`,
      `Libera o envio agora, mesmo sem o sistema ter detectado o chat aberto, e zera as esperas de nova tentativa. As mensagens saem no próximo ciclo (até 1 minuto). Use se você confirmou que o chat está aberto.`,
      'Forçar envio')) return;
    try {
      await api('/api/order/force_send', { method: 'POST', body: { order_id: orderId }});
      toast('Liberado — o envio acontece em até 1 minuto', 'ok');
      setTimeout(loadQueue, 3000);
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ════════════ LOGS ════════════
  state.fullLogs = [];

  async function loadFullLogs() {
    const box = $('log-full');
    if (!box) return;
    try {
      const st = await api('/api/status');
      state.fullLogs = st.logs || [];
      renderFullLogs();
      if ($('log-autorefresh')?.checked && state.currentScreen === 'logs') {
        clearTimeout(state.logTimer);
        state.logTimer = setTimeout(loadFullLogs, 15000);
      }
    } catch (e) {
      box.innerHTML = `<div class="muted small" style="color:var(--danger)">Erro: ${esc(e.message)}</div>`;
    }
  }

  function renderFullLogs() {
    const box = $('log-full');
    if (!box) return;
    const q = ($('log-search')?.value || '').toLowerCase();
    const f = $('log-filter')?.value || '';
    let lines = state.fullLogs;
    if (q) lines = lines.filter(l => String(l).toLowerCase().includes(q));
    if (f) { const re = new RegExp(f); lines = lines.filter(l => re.test(String(l))); }
    const cnt = $('log-count');
    if (cnt) cnt.textContent = `${lines.length} de ${state.fullLogs.length} linha(s)`;
    box.innerHTML = '';
    if (!lines.length) {
      box.innerHTML = '<div class="muted small" style="padding:16px;text-align:center">Nada encontrado.</div>';
      return;
    }
    lines.forEach(l => box.appendChild(el('div', { class: 'log-line' }, l)));
  }

  function exportLogs() {
    const q = ($('log-search')?.value || '').toLowerCase();
    const lines = q ? state.fullLogs.filter(l => String(l).toLowerCase().includes(q)) : state.fullLogs;
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ml-sender-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ════════════ CSV DE PRODUTOS ════════════
  async function exportProductsCSV() {
    if (!state.products.length) { toast('Carregue os produtos primeiro', 'warn'); return; }
    // messages were never exported before (wrong variable) — load them all first
    const all = await loadAllMessages();
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['id', 'title', 'enabled', 'delay_min', 'delay_max', 'product_key', 'msg1', 'msg2', 'msg3', 'msg4'];
    const rows = state.products.map(p => {
      const msgs = (all && all[p.id]) || [];
      return [p.id, p.title || '', p.enabled ? 1 : 0, p.delay_min ?? 15, p.delay_max ?? 90,
              p.product_key || '', msgs[0] || '', msgs[1] || '', msgs[2] || '', msgs[3] || ''].map(q).join(',');
    });
    const blob = new Blob(['\ufeff' + [head.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `produtos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Parser de CSV que respeita aspas e quebras de linha dentro do campo
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', inQ = false;
    text = text.replace(/^\ufeff/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',' || c === ';') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim()));
  }

  async function importProductsCSV(file) {
    try {
      const rows = parseCSV(await file.text());
      if (rows.length < 2) { toast('CSV vazio ou sem linhas de dados', 'err'); return; }
      const head = rows[0].map(h => h.trim().toLowerCase());
      const col = n => head.indexOf(n);
      if (col('id') < 0) { toast('CSV precisa ter a coluna "id"', 'err'); return; }
      const items = rows.slice(1).map(r => {
        const get = n => { const i = col(n); return i >= 0 ? r[i] : undefined; };
        const msgs = ['msg1', 'msg2', 'msg3', 'msg4'].map(get).filter(x => x && String(x).trim());
        const it = { id: (get('id') || '').trim() };
        const en = get('enabled');
        if (en !== undefined && String(en).trim() !== '') it.enabled = ['1', 'true', 'sim', 'yes'].includes(String(en).trim().toLowerCase());
        if (get('delay_min') !== undefined && String(get('delay_min')).trim() !== '') it.delay_min = Number(get('delay_min'));
        if (get('delay_max') !== undefined && String(get('delay_max')).trim() !== '') it.delay_max = Number(get('delay_max'));
        if (get('product_key') !== undefined && String(get('product_key')).trim() !== '') it.product_key = get('product_key');
        if (msgs.length) it.messages = msgs;
        return it;
      }).filter(i => i.id);
      if (!items.length) { toast('Nenhuma linha válida no CSV', 'err'); return; }
      if (!await confirm('Importar CSV',
        `Vai atualizar ${items.length} anúncio(s) com os dados do arquivo. Anúncios que não existirem na conta são ignorados. Esta ação sobrescreve mensagens e delays dos anúncios listados.`,
        'Importar')) return;
      const r = await api('/api/products/bulk_import', { method: 'POST', body: { items } });
      toast(`${r.updated} anúncio(s) atualizado(s)${r.skipped_count ? ` · ${r.skipped_count} ignorado(s)` : ''}`, 'ok');
      loadProducts();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ════════════ RESPOSTAS RÁPIDAS ════════════
  state.quickReplies = [];

  async function loadQuickReplies() {
    try { state.quickReplies = await api('/api/quick_replies'); } catch { state.quickReplies = []; }
    renderQuickRepliesConfig();
  }

  function renderQuickRepliesConfig() {
    const cont = $('qr-list');
    if (!cont) return;
    cont.innerHTML = '';
    if (!state.quickReplies.length) {
      cont.innerHTML = '<div class="muted small">Nenhuma resposta rápida. Ex.: "Envio imediato" → "Sim! A entrega é automática e imediata."</div>';
      return;
    }
    state.quickReplies.forEach((qr, i) => {
      const item = el('div', { class: 'ai-faq-item' });
      const fields = el('div', { class: 'faq-fields' });
      const l = el('input', { placeholder: 'Rótulo do botão (ex: Envio imediato)' });
      l.value = qr.label || ''; l.oninput = () => state.quickReplies[i].label = l.value;
      const t = el('input', { placeholder: 'Texto que será enviado' });
      t.value = qr.text || ''; t.oninput = () => state.quickReplies[i].text = t.value;
      fields.append(l, t);
      const del = el('button', { class: 'btn ghost sm', onclick: () => { state.quickReplies.splice(i, 1); renderQuickRepliesConfig(); } }, '✕');
      item.append(fields, del);
      cont.appendChild(item);
    });
  }

  async function saveQuickReplies() {
    try {
      const r = await api('/api/quick_replies', { method: 'POST', body: { items: state.quickReplies } });
      toast(`${r.count} resposta(s) rápida(s) salva(s)`, 'ok');
      loadQuickReplies();
    } catch (e) { toast(e.message, 'err'); }
  }


  // ════════════ TELEGRAM ════════════
  const TG_ALERTS = [
    ['new_question', 'Pergunta de comprador'],
    ['claim', 'Reclamação aberta'],
    ['token_fail', 'Falha ao renovar token'],
    ['rate_limit', 'Rate limit do ML'],
    ['recovered', 'Pedido recuperado'],
    ['key_low', 'Estoque de chaves baixo'],
    ['watchdog', 'Verificação de saúde'],
    ['daily_summary', 'Resumo diário'],
  ];
  state.tgAlerts = {};

  async function loadTelegram() {
    try {
      const tg = await api('/api/telegram');
      state.tgAlerts = tg.alerts || {};
      const st = $('tg-status');
      if (st) st.textContent = tg.enabled && tg.chat_id
        ? `✓ Conectado (chat ${tg.chat_id})`
        : (tg.has_token ? '⚠ Token salvo, mas não conectado — envie /start no bot e clique em Conectar' : '⚠ Não configurado');
      const box = $('tg-alerts');
      if (box) {
        box.innerHTML = '<div class="muted small" style="margin-bottom:6px">Quais alertas receber:</div>';
        TG_ALERTS.forEach(([k, label]) => {
          const row = el('label', { class: 'switch-row' });
          const cb = el('input', { type: 'checkbox' });
          cb.checked = state.tgAlerts[k] !== false;
          cb.onchange = () => state.tgAlerts[k] = cb.checked;
          row.append(cb, el('span', {}, label));
          box.appendChild(row);
        });
      }
      const bk = $('tg-backup-info');
      if (bk) bk.textContent = tg.last_backup
        ? `📦 Último backup semanal enviado em ${new Date(Number(tg.last_backup)).toLocaleString('pt-BR')}`
        : '📦 O backup semanal começa a ser enviado assim que o Telegram estiver conectado.';
    } catch (e) { /* silent */ }
  }

  async function connectTelegram() {
    const token = $('tg-token')?.value.trim();
    try {
      const r = await api('/api/telegram/connect', { method: 'POST', body: token ? { token } : {} });
      toast(`Conectado${r.name ? ' — ' + r.name : ''}. Veja a mensagem no Telegram.`, 'ok');
      if ($('tg-token')) $('tg-token').value = '';
      loadTelegram();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function saveTelegramAlerts() {
    try {
      await api('/api/telegram', { method: 'POST', body: { alerts: state.tgAlerts } });
      toast('Alertas salvos', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ════════════ CHAVES DE PRODUTO ════════════
  state.keysItem = null;

  async function initKeysScreen() {
    const sel = $('keys-product');
    if (!sel) return;
    if (!state.products.length) {
      try { state.products = await api('/api/products'); } catch (e) { toast(e.message, 'err'); return; }
    }
    if (!sel.options.length) {
      state.products.forEach(p => sel.appendChild(el('option', { value: p.id },
        `${(p.title || p.id).slice(0, 60)}`)));
    }
    if (!state.keysItem) state.keysItem = sel.value || state.products[0]?.id;
    sel.value = state.keysItem;
    loadKeys();
    loadKeysSummary();
  }

  async function loadKeysSummary() {
    try {
      const sum = await api('/api/keys/summary');
      const box = $('keys-summary');
      if (!box) return;
      if (!sum.length) { box.textContent = 'Nenhum anúncio usando estoque de chaves ainda.'; return; }
      const low = sum.filter(s => s.low).length;
      box.textContent = `${sum.length} anúncio(s) com estoque` + (low ? ` · ⚠ ${low} com pouca chave` : '');
    } catch { /* silent */ }
  }

  function applyKeysModeUI() {
    const mode = $('keys-mode')?.value || 'fixed';
    const show = (id, on) => { const e = $(id); if (e) e.classList.toggle('hidden', !on); };
    show('keys-fixed-row', mode === 'fixed');
    show('keys-days-row', mode === 'rotate');
    show('keys-uses-row', mode === 'rotate');
    show('keys-stock-block', mode !== 'fixed');
    const hint = $('keys-mode-hint');
    if (hint) hint.textContent = {
      fixed: 'A mesma chave é enviada em toda venda. É o comportamento atual do sistema.',
      rotate: 'O sistema usa uma chave por vez. Quando ela atinge o limite de dias ou de vendas, passa sozinho para a próxima do estoque.',
      pool: 'Cada venda consome uma chave diferente do estoque. Quando acaba, o anúncio é pausado automaticamente.',
    }[mode] || '';
  }

  async function loadKeys() {
    const itemId = $('keys-product')?.value;
    if (!itemId) return;
    state.keysItem = itemId;
    try {
      const d = await api(`/api/keys?item_id=${encodeURIComponent(itemId)}`);
      if ($('keys-mode')) $('keys-mode').value = d.mode || 'fixed';
      if ($('keys-fixed')) $('keys-fixed').value = d.product_key || '';
      if ($('keys-days')) $('keys-days').value = d.max_days || 0;
      if ($('keys-uses')) $('keys-uses').value = d.max_uses || 0;
      if ($('keys-low')) $('keys-low').value = d.low_threshold ?? 3;
      applyKeysModeUI();
      const st = $('keys-stats');
      if (st) st.innerHTML = `
        <div><span class="muted">Disponíveis:</span> <strong style="color:var(--accent)">${d.stats.available}</strong></div>
        <div><span class="muted">Em uso:</span> <strong>${d.stats.active}</strong></div>
        <div><span class="muted">Já usadas:</span> <strong>${d.stats.used}</strong></div>
        <div><span class="muted">Total:</span> <strong>${d.stats.total}</strong></div>`;
      const list = $('keys-list');
      if (list) {
        list.innerHTML = '';
        if (!d.keys.length) {
          list.innerHTML = '<div class="muted small" style="padding:14px;text-align:center">Nenhuma chave cadastrada.</div>';
        } else {
          d.keys.forEach(k => {
            const row = el('div', { class: 'msg-prod-row' });
            const info = el('div', { class: 'msg-prod-info' });
            info.appendChild(el('div', { class: 'msg-prod-title' }, k.key));
            const tag = k.status === 'available' ? '🟢 disponível'
                      : k.status === 'active' ? `🔵 em uso (${k.uses} venda(s))`
                      : `⚫ usada${k.order_id ? ' · pedido ' + k.order_id : ''}`;
            info.appendChild(el('div', { class: 'msg-prod-meta' }, el('span', {}, tag)));
            const del = el('button', { class: 'btn ghost sm', onclick: async () => {
              if (!await confirm('Remover chave', `Remover "${k.key}" do estoque?`, 'Remover', true)) return;
              try { await api('/api/keys/delete', { method: 'POST', body: { item_id: itemId, key_id: k.id } }); loadKeys(); }
              catch (e) { toast(e.message, 'err'); }
            }}, '✕');
            row.append(el('span', {}), info, del);
            list.appendChild(row);
          });
        }
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  async function saveKeysMode() {
    const itemId = $('keys-product')?.value;
    if (!itemId) return;
    try {
      await api('/api/keys/mode', { method: 'POST', body: {
        item_id: itemId,
        mode: $('keys-mode')?.value,
        max_days: Number($('keys-days')?.value || 0),
        max_uses: Number($('keys-uses')?.value || 0),
        low_threshold: Number($('keys-low')?.value || 0),
        product_key: $('keys-fixed')?.value || '',
      }});
      toast('Configuração salva', 'ok');
      loadKeys(); loadKeysSummary();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function addKeys() {
    const itemId = $('keys-product')?.value;
    const raw = $('keys-input')?.value || '';
    const keys = raw.split(/[\r\n;]+/).map(k => k.trim()).filter(Boolean);
    if (!keys.length) { toast('Cole ao menos uma chave', 'warn'); return; }
    try {
      const r = await api('/api/keys/add', { method: 'POST', body: { item_id: itemId, keys } });
      toast(`${r.added} chave(s) adicionada(s)${r.duplicates ? ` · ${r.duplicates} duplicada(s) ignorada(s)` : ''}`, 'ok');
      if ($('keys-input')) $('keys-input').value = '';
      loadKeys(); loadKeysSummary();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadAgentStatus() {
    const box = $('ai-agent-status');
    if (!box) return;
    try {
      const st = await api('/api/ai/agent/status');
      const mins = st.last_seen ? Math.max(0, Math.round((Date.now() - st.last_seen) / 60000)) : null;
      box.textContent = st.online
        ? `🟢 online (sinal há ${mins} min — o agente avisa a cada 20 min) · ${st.pending} na fila · ${st.done_24h} respondidas em 24h`
        : (st.last_seen ? `🔴 sem sinal desde ${new Date(st.last_seen).toLocaleString('pt-BR')} · ${st.pending} na fila`
                        : '🔴 nunca conectou');
    } catch { box.textContent = ''; }
  }

  // ════════════ INBOX / CONVERSAS ════════════
  state.inboxActivePack = null;

  async function loadInbox() {
    const listEl = $('inbox-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="muted small" style="padding:16px;text-align:center">Carregando…</div>';
    try {
      const [convos, suggestions] = await Promise.all([
        api('/api/inbox/list'),
        api('/api/inbox/suggestions').catch(() => []),
      ]);
      renderSuggestionsBar(suggestions);
      const cnt = $('inbox-count');
      if (cnt) cnt.textContent = `${convos.length} conversa(s)`;
      listEl.innerHTML = '';
      if (!convos.length) {
        listEl.innerHTML = '<div class="muted small" style="padding:16px;text-align:center">Nenhuma conversa ainda.</div>';
        return;
      }
      convos.forEach(c => {
        const row = el('div', { class: 'inbox-convo' + (c.pack_id === state.inboxActivePack ? ' active' : ''), 'data-pack': c.pack_id });
        const top = el('div', { class: 'inbox-convo-top' });
        top.appendChild(el('span', { class: 'inbox-convo-buyer' }, c.buyer));
        if (c.unread) top.appendChild(el('span', { class: 'inbox-unread-dot' }));
        row.appendChild(top);
        if (c.last_msg_preview) row.appendChild(el('div', { class: 'inbox-convo-preview' }, c.last_msg_preview));
        row.appendChild(el('div', { class: 'inbox-convo-preview' }, `Pedido ${c.order_id}`));
        row.addEventListener('click', () => openThread(c));
        listEl.appendChild(row);
      });
    } catch (e) {
      listEl.innerHTML = `<div class="muted small" style="padding:16px;color:var(--danger)">Erro: ${esc(e.message)}</div>`;
    }
  }

  function renderSuggestionsBar(suggestions) {
    const bar = $('inbox-suggestions-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!suggestions || !suggestions.length) return;
    const header = el('div', { class: 'muted small', style: 'margin:8px 0;font-weight:600' },
      `🤖 ${suggestions.length} pergunta(s) com sugestão da IA aguardando`);
    bar.appendChild(header);
    suggestions.forEach(s => {
      const card = el('div', { class: 'sugg-card' });
      card.appendChild(el('div', { class: 'muted small' }, `Pergunta: "${s.question}"`));
      if (s.suggested_reply) {
        card.appendChild(el('div', { style: 'margin:6px 0;font-size:14px' }, `Sugestão: ${s.suggested_reply}`));
      } else {
        card.appendChild(el('div', { class: 'muted small', style: 'margin:6px 0' }, `IA não respondeu: ${s.reason || 'requer sua atenção'}`));
      }
      const acts = el('div', { style: 'display:flex;gap:8px;margin-top:6px' });
      acts.appendChild(el('button', { class: 'btn dark sm', onclick: () => {
        openThread({ pack_id: s.pack_id, buyer_id: s.buyer_id, buyer: 'Comprador', order_id: '' }, s.suggested_reply);
      }}, 'Abrir conversa'));
      acts.appendChild(el('button', { class: 'btn ghost sm', onclick: async () => {
        try { await api('/api/inbox/suggestions/dismiss', { method: 'POST', body: { pack_id: s.pack_id } }); loadInbox(); }
        catch (e) { toast(e.message, 'err'); }
      }}, 'Descartar'));
      card.appendChild(acts);
      bar.appendChild(card);
    });
  }

  async function openThread(convo, prefillReply) {
    state.inboxActivePack = convo.pack_id;
    $$('#inbox-list .inbox-convo').forEach(r =>
      r.classList.toggle('active', r.dataset.pack === convo.pack_id));
    const threadEl = $('inbox-thread');
    if (!threadEl) return;
    threadEl.innerHTML = '<div class="inbox-empty muted">Carregando conversa…</div>';
    try {
      const data = await api(`/api/inbox/thread?pack_id=${encodeURIComponent(convo.pack_id)}`);
      threadEl.innerHTML = '';
      const msgsEl = el('div', { class: 'inbox-messages' });
      if (!data.messages || !data.messages.length) {
        msgsEl.appendChild(el('div', { class: 'muted small', style: 'margin:auto' }, 'Sem mensagens nesta conversa.'));
      } else {
        data.messages.forEach(m => {
          const bubble = el('div', { class: 'inbox-msg ' + (m.from === 'seller' ? 'seller' : 'buyer') });
          bubble.appendChild(el('div', {}, m.text || '(sem texto)'));
          if (m.date) {
            const d = new Date(m.date);
            bubble.appendChild(el('div', { class: 'inbox-msg-time' },
              isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })));
          }
          msgsEl.appendChild(bubble);
        });
      }
      threadEl.appendChild(msgsEl);

      // AI suggestion box
      const suggestion = data.suggestion || (prefillReply ? { suggested_reply: prefillReply } : null);

      const composer = el('div', { class: 'inbox-composer' });
      if (suggestion && suggestion.suggested_reply) {
        const sbox = el('div', { class: 'inbox-suggestion-box' });
        sbox.appendChild(el('div', { class: 'sg-label' }, '🤖 Sugestão da IA'));
        sbox.appendChild(el('div', { style: 'margin:4px 0;font-size:13px' }, suggestion.suggested_reply));
        composer.appendChild(sbox);
      }
      const ta = el('textarea', { placeholder: 'Escreva sua resposta…' });
      // Respostas rápidas: um clique preenche o campo (sem IA, sem custo)
      const qrs = data.quick_replies || state.quickReplies || [];
      if (qrs.length) {
        const qrRow = el('div', { class: 'qr-row' });
        qrs.forEach(q => {
          qrRow.appendChild(el('button', {
            class: 'btn ghost sm', title: q.text,
            onclick: () => { ta.value = q.text; ta.focus(); }
          }, q.label));
        });
        composer.appendChild(qrRow);
      }
      if (prefillReply) ta.value = prefillReply;
      else if (suggestion && suggestion.suggested_reply) ta.value = suggestion.suggested_reply;
      composer.appendChild(ta);
      const acts = el('div', { class: 'inbox-composer-actions' });
      const sendBtn = el('button', { class: 'btn green' }, 'Enviar resposta');
      sendBtn.addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) { toast('Escreva uma mensagem', 'warn'); return; }
        sendBtn.disabled = true;
        try {
          await api('/api/inbox/send', { method: 'POST', body: {
            pack_id: convo.pack_id, buyer_id: convo.buyer_id, text
          }});
          toast('Mensagem enviada', 'ok');
          openThread(convo);
          loadInbox();
        } catch (e) { toast(e.message, 'err'); sendBtn.disabled = false; }
      });
      // "Enviar template" — enfileira o template com o mesmo fluxo de pausas
      const tplBtn = el('button', { class: 'btn dark' }, '📋 Enviar template');
      tplBtn.addEventListener('click', () => openTemplatePicker(convo));
      acts.appendChild(tplBtn);
      acts.appendChild(sendBtn);
      composer.appendChild(acts);
      threadEl.appendChild(composer);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    } catch (e) {
      threadEl.innerHTML = `<div class="inbox-empty muted" style="color:var(--danger)">Erro: ${esc(e.message)}</div>`;
    }
  }

  // ─── Enviar template numa conversa (entra na fila, com pausas) ───
  async function openTemplatePicker(convo) {
    let lib = {};
    try { lib = await api('/api/templates'); } catch (e) { toast(e.message, 'err'); return; }
    const names = Object.keys(lib || {});
    if (!names.length) {
      toast('Nenhum template salvo. Crie um em Mensagens → Novo template.', 'warn');
      return;
    }
    const body = el('div');
    body.appendChild(el('p', { class: 'muted small' },
      'O template entra na fila e é enviado com as mesmas pausas do envio automático (não dispara tudo de uma vez).'));
    const sel = el('select', { style: 'width:100%;margin:10px 0' });
    names.forEach(n => sel.appendChild(el('option', { value: n }, `${n} (${(lib[n] || []).length} msg)`)));
    body.appendChild(sel);
    const preview = el('div', { class: 'msg-vars', style: 'font-size:13px;white-space:pre-wrap;max-height:200px;overflow:auto' });
    const renderPreview = () => {
      const msgs = lib[sel.value] || [];
      preview.textContent = msgs.map((m, i) => `${i + 1}. ${m}`).join('\n\n') || '(vazio)';
    };
    sel.onchange = renderPreview; renderPreview();
    body.appendChild(preview);

    if (!await confirmNode(`Enviar template para ${convo.buyer || 'comprador'}`, body, 'Enfileirar e enviar')) return;
    try {
      const r = await api('/api/inbox/send_template', { method: 'POST', body: {
        pack_id: convo.pack_id, buyer_id: convo.buyer_id, buyer: convo.buyer,
        order_id: convo.order_id, item_id: convo.item_id, template: sel.value,
      }});
      toast(`Template na fila — ${r.queued} mensagem(ns) sairão com pausas`, 'ok');
      setTimeout(() => openThread(convo), 4000);
    } catch (e) { toast(e.message, 'err'); }
  }

  // Variante de confirm() que aceita um nó DOM como corpo (reusa o mesmo modal)
  function confirmNode(title, node, okLabel) {
    return new Promise(resolve => {
      const t = $('modal-title'), b = $('modal-body'), a = $('modal-actions'), m = $('modal');
      if (!t || !b || !a || !m) { resolve(window.confirm(title)); return; }
      t.textContent = title;
      b.innerHTML = '';
      b.appendChild(node);
      a.innerHTML = '';
      const close = v => { m.classList.add('hidden'); b.innerHTML = ''; resolve(v); };
      a.append(
        el('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancelar'),
        el('button', { class: 'btn blue', onclick: () => close(true) }, okLabel || 'Confirmar')
      );
      m.classList.remove('hidden');
    });
  }

  // ════════════ AI CONFIG ════════════
  state.aiFaq = [];

  const AI_PRESETS = {
    workers_ai: [
      { label: 'Llama 3.1 8B (rápido, equilibrado)', model: '@cf/meta/llama-3.1-8b-instruct' },
      { label: 'Llama 3.3 70B (mais capaz, mais lento)', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
      { label: 'Mistral 7B', model: '@cf/mistral/mistral-7b-instruct-v0.2' },
    ],
    openai_compat: [
      { label: 'Ollama local (via túnel)', base: 'https://SEU-TUNEL/v1', model: 'llama3.1:8b' },
      { label: 'LM Studio local (via túnel)', base: 'https://SEU-TUNEL/v1', model: 'local-model' },
      { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { label: 'Qwen (Alibaba)', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
      { label: 'Kimi (Moonshot)', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
      { label: 'GLM (Zhipu)', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      { label: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    ],
    openai: [
      { label: 'gpt-4o-mini (barato)', model: 'gpt-4o-mini' },
      { label: 'gpt-4o', model: 'gpt-4o' },
    ],
    anthropic: [
      { label: 'Claude Haiku (barato e rápido)', model: 'claude-haiku-4-5-20251001' },
      { label: 'Claude Sonnet', model: 'claude-sonnet-4-5' },
    ],
  };
  const AI_HINTS = {
    workers_ai: 'Roda dentro da própria Cloudflare, com cota diária gratuita. Exige o binding "AI" no Worker (Settings → Bindings → Workers AI). Não precisa de chave nem de PC ligado.',
    openai_compat: 'Qualquer serviço que fale o protocolo da OpenAI. Para IA local, o PC precisa ficar ligado e acessível pela internet (Cloudflare Tunnel). Modelos pequenos erram mais o formato — nesse caso a resposta vira sugestão em vez de envio automático.',
    openai: 'Serviço pago por uso. Custa frações de centavo por resposta no seu volume.',
    anthropic: 'Serviço pago por uso, com endpoint próprio. A assinatura do Claude Pro não serve aqui — é preciso chave da API.',
    local_agent: 'A IA roda no seu PC com Ollama. Um agente busca as perguntas aqui — sem túnel, sem porta aberta, sem IP fixo. Com o PC desligado, as perguntas viram sugestões no Inbox.',
  };

  function applyAIProviderUI() {
    const prov = $('ai-provider')?.value || 'openai';
    const show = (id, on) => { const e = $(id); if (e) e.classList.toggle('hidden', !on); };
    show('ai-baseurl-row', prov === 'openai_compat');
    show('ai-key-row', prov !== 'workers_ai' && prov !== 'local_agent');
    show('ai-agent-box', prov === 'local_agent');
    if (prov === 'local_agent') loadAgentStatus();
    show('ai-preset-row', true);
    const hint = $('ai-provider-hint');
    if (hint) hint.textContent = AI_HINTS[prov] || '';
    const sel = $('ai-preset');
    if (sel) {
      sel.innerHTML = '<option value="">— escolher preset —</option>';
      (AI_PRESETS[prov] || []).forEach((pr, i) =>
        sel.appendChild(el('option', { value: String(i) }, pr.label)));
    }
  }

  async function loadAIConfig() {
    try {
      const cfg = await api('/api/ai/config');
      if ($('ai-enabled')) $('ai-enabled').checked = !!cfg.enabled;
      if ($('ai-autoreply')) $('ai-autoreply').checked = !!cfg.auto_reply;
      if ($('ai-rules')) $('ai-rules').value = cfg.rules || '';
      if ($('ai-provider')) $('ai-provider').value = cfg.provider || 'openai';
      if ($('ai-baseurl')) $('ai-baseurl').value = cfg.base_url || '';
      if ($('ai-model')) $('ai-model').value = cfg.model || '';
      applyAIProviderUI();
      const status = $('ai-key-status');
      if (status) status.textContent = cfg.has_key
        ? '✓ Chave configurada (deixe em branco para manter)'
        : '⚠ Nenhuma chave configurada';
      const provHint = $('ai-provider-hint');
      if (provHint && (cfg.provider || 'openai') === 'workers_ai' && !cfg.workers_ai_available) {
        provHint.textContent = '⚠ O binding "AI" ainda NÃO está ativo neste Worker. Adicione em Cloudflare → seu Worker → Settings → Bindings → Workers AI.';
      }
      state.aiFaq = cfg.faq || [];
      renderAIFaq();
    } catch (e) { /* silent */ }
  }

  function renderAIFaq() {
    const cont = $('ai-faq-list');
    if (!cont) return;
    cont.innerHTML = '';
    if (!state.aiFaq.length) {
      cont.innerHTML = '<div class="muted small">Nenhuma pergunta cadastrada. Adicione perguntas frequentes e suas respostas.</div>';
      return;
    }
    state.aiFaq.forEach((f, idx) => {
      const item = el('div', { class: 'ai-faq-item' });
      const fields = el('div', { class: 'faq-fields' });
      const qIn = el('input', { placeholder: 'Pergunta (ex: consegue enviar agora?)' });
      qIn.value = f.q || '';
      qIn.oninput = () => state.aiFaq[idx].q = qIn.value;
      const aIn = el('input', { placeholder: 'Resposta oficial' });
      aIn.value = f.a || '';
      aIn.oninput = () => state.aiFaq[idx].a = aIn.value;
      fields.append(qIn, aIn);
      const del = el('button', { class: 'btn ghost sm', onclick: () => {
        state.aiFaq.splice(idx, 1); renderAIFaq();
      }}, '✕');
      item.append(fields, del);
      cont.appendChild(item);
    });
  }

  async function saveAIConfig() {
    const body = {
      enabled: $('ai-enabled')?.checked || false,
      auto_reply: $('ai-autoreply')?.checked || false,
      rules: $('ai-rules')?.value || '',
      faq: state.aiFaq.filter(f => (f.q || '').trim() && (f.a || '').trim()),
      provider: $('ai-provider')?.value || 'openai',
      base_url: $('ai-baseurl')?.value || '',
      model: $('ai-model')?.value || '',
    };
    const key = $('ai-key')?.value.trim();
    if (key) body.api_key = key;
    try {
      await api('/api/ai/config', { method: 'POST', body });
      toast('Configuração de IA salva', 'ok');
      if ($('ai-key')) $('ai-key').value = '';
      loadAIConfig();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function testAI() {
    const resultEl = $('ai-test-result');
    if (resultEl) resultEl.innerHTML = '<span class="muted small">Testando…</span>';
    try {
      const r = await api('/api/ai/test', { method: 'POST', body: {
        question: 'Olá, consegue me enviar o produto agora?',
        provider: $('ai-provider')?.value || undefined,
        base_url: $('ai-baseurl')?.value || undefined,
        model: $('ai-model')?.value || undefined,
        api_key: $('ai-key')?.value || undefined,
      }});
      if (resultEl) {
        const modeLabel = { auto: '✅ Responderia automaticamente', suggest: '📝 Geraria sugestão para revisão', skip: '⚠ Passaria para você' }[r.mode] || r.mode;
        resultEl.innerHTML = `
          <div class="msg-vars" style="font-size:13px">
            <div><strong>${esc(modeLabel)}</strong></div>
            <div style="margin-top:6px"><span class="muted">Resposta gerada:</span> ${esc(r.reply || '(nenhuma)')}</div>
            ${r.reason ? `<div class="muted small" style="margin-top:4px">Motivo: ${esc(r.reason)}</div>` : ''}
            <div class="muted small" style="margin-top:4px">${esc(r.provider || '')} ${r.model ? '· ' + esc(r.model) : ''} ${r.latency_ms ? '· ' + Number(r.latency_ms) + 'ms' : ''}</div>
          </div>`;
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = `<span class="small" style="color:var(--danger)">Erro: ${esc(e.message)}</span>`;
    }
  }

  // ════════════ CRIAR ANÚNCIO ════════════
  // Fluxo simples: ponto de partida (copiar um anúncio seu ou do zero) →
  // categoria → dados, fotos, ficha técnica, descrição → validar → publicar.
  // O rascunho fica salvo neste navegador enquanto você preenche.
  state.cr = { mode: 'copy', cat: null, draft: null, pictures: [], templateTerms: [], seller: null, fees: [], uploading: 0,
    vars: [], batchSel: new Map(), batchRes: {}, feeCache: new Map(), feeSeq: 0, netBy: {}, pendingSender: null,
    busy: '', gen: 0, keyCfg: null };
  const CR_DRAFT_KEY = 'mlas_create_draft';
  const CR_MAX_BATCH = 10, CR_MAX_VARS = 5, CR_GAP_MS = 1500;
  // os dois formatos de anúncio: cada um com o seu preço
  const CR_FMT = [
    { lt: 'gold_special', name: 'Clássico', check: 'cr-fmt-classic', price: 'cr-price', fee: 'cr-fee-classic', row: 'cr-fmt-row-classic' },
    { lt: 'gold_pro', name: 'Premium', check: 'cr-fmt-premium', price: 'cr-price-premium', fee: 'cr-fee-premium', row: 'cr-fmt-row-premium' },
  ];
  const crNum = v => Number(String(v ?? '').replace(',', '.')) || 0;
  const crBrl = n => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
  const crFold = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const crSafeUrl = u => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
  const COND_LABEL = { new: 'Novo', used: 'Usado', not_specified: 'Não especificado' };
  const SHIP_LABEL = { not_specified: 'Sem envio pelo ML (produto digital / combinar)', me2: 'Mercado Envios', me1: 'Mercado Envios 1', custom: 'Frete personalizado' };

  async function initCreate() {
    if (!state.products.length) { try { state.products = await api('/api/products'); } catch (e) { /* lista vazia */ } }
    crSetMode(state.cr.mode);
    crRenderCopyList();
    if (!state.cr.seller) {
      api('/api/create/seller_info').then(s => {
        state.cr.seller = s;
        const n = $('cr-up-note');
        if (n) n.classList.toggle('hidden', !s.user_product_seller);
      }).catch(() => {});
    }
    if (!Object.keys(state.templates || {}).length) api('/api/templates').then(t => { state.templates = t || {}; crRenderTplOptions(); }).catch(() => {});
    else crRenderTplOptions();
    // unfinished draft from a previous visit
    if (!state.cr.cat) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(CR_DRAFT_KEY) || 'null'); } catch { /* ignore */ }
      const box = $('cr-restore');
      if (box) {
        box.innerHTML = '';
        box.classList.toggle('hidden', !(saved && saved.draft && saved.draft.category_id));
        if (saved && saved.draft && saved.draft.category_id) {
          const made = Object.values(saved.batch_done || {}).filter(r => r && r.status === 'ok').length;
          const when = new Date(saved.saved_at || Date.now()).toLocaleString('pt-BR');
          box.append(
            el('span', {}, made
              ? `📝 Rascunho em andamento: "${String(saved.draft.title || 'sem título').slice(0, 50)}" — ${made} anúncio(s) já publicado(s) a partir dele (${when})`
              : `📝 Rascunho não publicado: "${String(saved.draft.title || 'sem título').slice(0, 50)}" (${when})`),
            el('button', { class: 'btn green sm', onclick: () => crRestore(saved) }, 'Continuar'),
            el('button', { class: 'btn ghost sm', onclick: () => { localStorage.removeItem(CR_DRAFT_KEY); box.classList.add('hidden'); } }, 'Descartar'));
        }
      }
    }
  }

  function wireCreateHandlers() {
    $$('[data-cr-start]').forEach(b => b.addEventListener('click', () => crSetMode(b.dataset.crStart)));
    bind('cr-copy-search', 'input', crRenderCopyList);
    bind('btn-cr-copy-url', 'click', crCopyFromLink);
    bind('cr-copy-url', 'keydown', e => { if (e.key === 'Enter') crCopyFromLink(); });
    bind('btn-cr-add-var', 'click', () => crAddVar(''));
    bind('btn-cr-match-net', 'click', crMatchNet);
    for (const f of CR_FMT) {
      bind(f.check, 'change', () => { crFormatUI(); crFees(); });
      // digitar um preço já marca o formato
      bind(f.price, 'input', () => { const c = $(f.check); if (c && !c.checked && crNum($(f.price).value) > 0) { c.checked = true; crFormatUI(); } clearTimeout(state.cr.feeT); state.cr.feeT = setTimeout(crFees, 600); });
    }
    bind('btn-cr-predict', 'click', crPredict);
    bind('cr-predict-q', 'keydown', e => { if (e.key === 'Enter') crPredict(); });
    bind('cr-title', 'input', crTitleCount);
    bind('btn-cr-addphoto', 'click', () => $('cr-photo-file')?.click());
    bind('cr-photo-file', 'change', e => { const f = Array.from(e.target.files || []); e.target.value = ''; crAddPhotos(f); });
    bind('btn-cr-photo-url', 'click', crAddPhotoUrl);
    bind('btn-cr-validate', 'click', crValidate);
    bind('btn-cr-publish', 'click', () => crPublish('active'));
    bind('btn-cr-publish-paused', 'click', () => crPublish('paused'));
    bind('btn-cr-reset', 'click', crReset);
    bind('btn-cr-ai-desc', 'click', crAIDesc);
    bind('btn-cr-ai-title', 'click', crAITitle);
    bind('cr-sender-on', 'change', crSenderToggle);
    bind('cr-sender-tpl', 'change', crApplyTpl);
    bind('cr-warranty-type', 'change', crWarrantyUI);
    const root = $('cr-root');
    if (root) { root.addEventListener('input', crOnEdit); root.addEventListener('change', crOnEdit); }
  }

  // Any edit: the last "validado" no longer applies, the list of listings to
  // create is redrawn (titles × formats) and the draft is saved.
  function crOnEdit(e) {
    if (e && e.target && e.target.closest && e.target.closest('#cr-batch')) { crAutosave(); return; }
    let changed = false;
    for (const k of Object.keys(state.cr.batchRes)) if (['valid', 'invalid'].includes(state.cr.batchRes[k].status)) { delete state.cr.batchRes[k]; changed = true; }
    clearTimeout(state.cr.batchT);
    state.cr.batchT = setTimeout(crRenderBatch, changed ? 0 : 150);
    crAutosave();
  }

  function crSetMode(mode) {
    state.cr.mode = mode === 'scratch' ? 'scratch' : 'copy';
    $$('[data-cr-start]').forEach(b => b.classList.toggle('active', b.dataset.crStart === state.cr.mode));
    $('cr-copy-box')?.classList.toggle('hidden', state.cr.mode !== 'copy');
    $('cr-scratch-box')?.classList.toggle('hidden', state.cr.mode !== 'scratch');
  }

  function crRenderCopyList() {
    const list = $('cr-copy-list');
    if (!list) return;
    const q = ($('cr-copy-search')?.value || '').toLowerCase();
    const items = state.products.filter(p => !q || `${p.title || ''}${p.id}`.toLowerCase().includes(q)).slice(0, 80);
    list.innerHTML = '';
    if (!items.length) { list.appendChild(el('div', { class: 'muted small', style: 'padding:14px;text-align:center' }, state.products.length ? 'Nenhum anúncio encontrado.' : 'Carregando seus anúncios…')); return; }
    items.forEach(p => {
      const row = el('div', { class: 'msg-prod-row cr-copy-row' });
      const img = p.thumbnail ? el('img', { src: p.thumbnail, alt: '', class: 'cr-thumb-sm', loading: 'lazy' }) : el('span', { class: 'cr-thumb-sm' });
      const info = el('div', { class: 'msg-prod-info' });
      info.appendChild(el('div', { class: 'msg-prod-title' }, p.title || p.id));
      info.appendChild(el('div', { class: 'msg-prod-meta' }, el('span', {}, p.id), el('span', {}, p.price ? `R$ ${Number(p.price).toFixed(2).replace('.', ',')}` : ''),
        el('span', { class: 'tag ' + (p.listing_status === 'active' ? 'done' : 'pending') }, p.listing_status === 'active' ? 'Ativo' : 'Pausado')));
      row.append(img, info, el('button', { class: 'btn dark sm', onclick: e => { e.stopPropagation(); crLoadTemplate(p.id); } }, 'Usar como base'));
      row.addEventListener('click', () => crLoadTemplate(p.id));
      list.appendChild(row);
    });
  }

  async function crPredict() {
    const q = ($('cr-predict-q')?.value || '').trim();
    const box = $('cr-predict-list');
    if (q.length < 3) { toast('Escreva o nome do produto (pelo menos 3 letras)', 'warn'); return; }
    box.innerHTML = '<div class="muted small">Procurando categorias…</div>';
    try {
      const list = await api(`/api/create/predict?q=${encodeURIComponent(q)}`);
      box.innerHTML = '';
      if (!list.length) { box.appendChild(el('div', { class: 'muted small' }, 'O Mercado Livre não sugeriu categorias. Tente descrever o produto de outro jeito.')); return; }
      box.appendChild(el('div', { class: 'muted small', style: 'margin:6px 0' }, 'Escolha a categoria (a primeira é a mais provável):'));
      list.forEach((c, i) => {
        const b = el('button', { class: 'cr-cat-opt' + (i === 0 ? ' best' : ''), onclick: () => {
          if (!$('cr-title').value) $('cr-title').value = q.slice(0, 60);
          crSelectCategory(c.category_id, c.attributes || []);
        } });
        b.append(el('strong', {}, c.category_name || c.category_id), el('span', { class: 'muted small' }, c.path || c.domain_name || ''));
        box.appendChild(b);
      });
    } catch (e) { box.innerHTML = ''; box.appendChild(el('div', { class: 'small', style: 'color:var(--danger)' }, e.message)); }
  }

  // Resolves true only when the form was actually filled with this category
  // (and `onReady` ran). A category that can't take listings, or a lookup
  // error, leaves the current form untouched — the caller must not go on as if
  // the new starting point had been loaded.
  async function crSelectCategory(catId, prefill = [], draft = null, onReady = null) {
    const info = $('cr-cat-info');
    const before = [...info.childNodes];
    info.textContent = 'Carregando categoria…';
    let cat;
    try { cat = await api(`/api/create/category?id=${encodeURIComponent(catId)}`); }
    catch (e) { info.replaceChildren(...before); toast(e.message, 'err', 7000); return false; }
    if (!cat.leaf || cat.listing_allowed === false) {
      info.innerHTML = '';
      const kids = cat.children || [];
      if (!kids.length) {
        info.append(...before);
        toast(`A categoria "${cat.name || catId}" não aceita anúncios novos no Mercado Livre. Escolha outra (Começar do zero → Sugerir categoria).`, 'err', 9000);
        return false;
      }
      // not a final category: let the user go one level down
      info.appendChild(el('div', { class: 'small', style: 'color:var(--warning);margin-bottom:6px' }, `"${cat.name}" é uma categoria geral. Escolha uma mais específica:`));
      const wrap = el('div', { class: 'cr-children' });
      kids.forEach(ch => wrap.appendChild(el('button', { class: 'btn ghost sm', onclick: () => crSelectCategory(ch.id, prefill, draft, onReady) }, ch.name)));
      info.appendChild(wrap);
      return false;
    }
    state.cr.cat = cat;
    info.innerHTML = '';
    info.append(el('span', {}, '📂 '), el('strong', {}, cat.path || cat.name), el('span', { class: 'muted small' }, ` (${cat.id})`),
      el('button', { class: 'btn ghost sm', style: 'margin-left:8px', onclick: () => {
        if (state.cr.busy) { toast('Espere a validação/publicação em andamento terminar', 'warn'); return; }
        state.cr.cat = null; crShowForm(false); info.textContent = '';
      } }, 'trocar'));
    crShowForm(true);
    const s = cat.settings || {};
    const t = $('cr-title'); t.maxLength = s.max_title_length || 60; crTitleCount();
    const cond = $('cr-condition'); cond.innerHTML = '';
    (s.item_conditions && s.item_conditions.length ? s.item_conditions : ['new']).forEach(c => cond.appendChild(el('option', { value: c }, COND_LABEL[c] || c)));
    const ship = $('cr-shipping'); ship.innerHTML = '';
    const modes = (s.shipping_modes && s.shipping_modes.length) ? s.shipping_modes : ['not_specified'];
    modes.forEach(mo => ship.appendChild(el('option', { value: mo }, SHIP_LABEL[mo] || mo)));
    if (modes.includes('not_specified')) ship.value = 'not_specified';
    // values from a draft/template or from the category predictor
    const cur = {};
    for (const a of (draft?.attributes || prefill || [])) if (a && a.id) cur[a.id] = a;
    crRenderAttrs(cat, cur);
    if (draft) crFillForm(draft);
    $('cr-photo-max').textContent = `até ${Math.min(10, s.max_pictures_per_item || 10)} fotos`;
    if (onReady) onReady();
    crRenderVars(); crFormatUI();
    crFees();
    crAutosave();
    $('cr-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function crShowForm(on) {
    ['cr-form', 'cr-photos-block', 'cr-attrs-block', 'cr-desc-block', 'cr-sender-block', 'cr-publish-block']
      .forEach(id => $(id)?.classList.toggle('hidden', !on));
  }

  function crRenderAttrs(cat, cur) {
    const req = $('cr-attrs-required'), more = $('cr-attrs-more');
    req.innerHTML = ''; more.innerHTML = '';
    const attrs = cat.attributes || [];
    const important = a => a.required || ['BRAND', 'MODEL', 'GTIN', 'EMPTY_GTIN_REASON'].includes(a.id);
    const main = attrs.filter(important);
    const rest = attrs.filter(a => !important(a)).sort((a, b) => (a.relevance || 2) - (b.relevance || 2));
    main.forEach(a => req.appendChild(crAttrInput(a, cur[a.id])));
    if (!main.length) req.appendChild(el('div', { class: 'muted small' }, 'Esta categoria não tem características obrigatórias.'));
    rest.forEach(a => more.appendChild(crAttrInput(a, cur[a.id])));
    $('cr-attrs-more-count').textContent = rest.length ? `(${rest.length})` : '';
    const gt = attrs.find(a => a.id === 'GTIN');
    $('cr-gtin-note')?.classList.toggle('hidden', !gt);
  }

  function crAttrInput(a, cur) {
    const wrap = el('label', { class: 'cr-attr' + (a.required ? ' req' : '') });
    wrap.appendChild(el('span', { class: 'cr-attr-name' }, a.name + (a.required ? ' *' : '')));
    let input;
    const vals = a.values || [];
    if ((a.type === 'list' || a.type === 'boolean') && vals.length) {
      input = el('select', { 'data-attr': a.id, 'data-kind': 'select' });
      input.appendChild(el('option', { value: '' }, '— escolher —'));
      vals.forEach(v => {
        const o = el('option', { value: v.id }, v.name);
        if (cur && (String(cur.value_id) === String(v.id) || (!cur.value_id && cur.value_name === v.name))) o.selected = true;
        input.appendChild(o);
      });
    } else if (a.type === 'number_unit' && (a.units || []).length) {
      input = el('div', { class: 'cr-unit' });
      const num = el('input', { type: 'number', step: 'any', min: '0', 'data-attr': a.id, 'data-kind': 'num' });
      const unit = el('select', { 'data-unit-for': a.id });
      a.units.forEach(u => unit.appendChild(el('option', { value: u }, u)));
      const m = String(cur?.value_name || '').match(/^([\d.,]+)\s*(.*)$/);
      if (m) { num.value = m[1].replace(',', '.'); if (m[2]) unit.value = m[2]; }
      else if (a.default_unit) unit.value = a.default_unit;
      input.append(num, unit);
    } else {
      input = el('input', { type: a.type === 'number' ? 'number' : 'text', 'data-attr': a.id, 'data-kind': 'text' });
      if (a.max_length) input.maxLength = a.max_length;
      if (vals.length) {
        const dl = el('datalist', { id: `dl-${a.id}` });
        vals.slice(0, 300).forEach(v => dl.appendChild(el('option', { value: v.name })));
        wrap.appendChild(dl);
        input.setAttribute('list', `dl-${a.id}`);
      }
      if (cur) input.value = cur.value_name || (vals.find(v => String(v.id) === String(cur.value_id))?.name || '');
    }
    wrap.appendChild(input);
    if (a.hint) wrap.appendChild(el('span', { class: 'muted small' }, a.hint));
    return wrap;
  }

  function crCollectAttrs() {
    const out = [];
    const attrs = state.cr.cat?.attributes || [];
    document.querySelectorAll('#cr-attrs-block [data-attr]').forEach(inp => {
      const id = inp.getAttribute('data-attr'), kind = inp.getAttribute('data-kind');
      const a = attrs.find(x => x.id === id);
      if (kind === 'select') {
        if (inp.value) out.push({ id, value_id: inp.value, value_name: inp.selectedOptions[0]?.textContent || '' });
      } else if (kind === 'num') {
        const u = document.querySelector(`[data-unit-for="${id}"]`);
        if (inp.value !== '') out.push({ id, value_name: `${inp.value} ${u?.value || ''}`.trim() });
      } else {
        const v = inp.value.trim();
        if (!v) return;
        const match = (a?.values || []).find(x => x.name.toLowerCase() === v.toLowerCase());
        out.push(match ? { id, value_id: match.id, value_name: match.name } : { id, value_name: v });
      }
    });
    return out;
  }

  function crTitleCount() {
    const t = $('cr-title'), c = $('cr-title-count');
    if (t && c) c.textContent = `${t.value.length}/${t.maxLength > 0 ? t.maxLength : 60}`;
  }

  function crWarrantyUI() {
    const type = $('cr-warranty-type')?.value || '';
    $('cr-warranty-time-wrap')?.classList.toggle('hidden', !type || type === 'Sem garantia');
  }

  function crFillForm(d) {
    $('cr-title').value = d.title || '';
    crTitleCount();
    const isPro = d.listing_type_id === 'gold_pro';
    $('cr-fmt-classic').checked = !isPro; $('cr-fmt-premium').checked = isPro;
    $('cr-price').value = isPro ? '' : (d.price ?? '');
    $('cr-price-premium').value = isPro ? (d.price ?? '') : '';
    $('cr-qty').value = d.available_quantity ?? 1;
    if (d.condition && [...$('cr-condition').options].some(o => o.value === d.condition)) $('cr-condition').value = d.condition;
    if (d.shipping?.mode && [...$('cr-shipping').options].some(o => o.value === d.shipping.mode)) $('cr-shipping').value = d.shipping.mode;
    $('cr-desc').value = d.description || '';
    state.cr.pictures = (d.pictures || []).filter(p => p && (p.id || p.url)).slice(0, 10).map(p => ({ id: p.id || '', url: p.url || '' }));
    crRenderPhotos();
    const terms = d.sale_terms || [];
    const wt = terms.find(s => s.id === 'WARRANTY_TYPE'), wtime = terms.find(s => s.id === 'WARRANTY_TIME');
    const sel = $('cr-warranty-type');
    const name = wt ? (wt.value_name || '') : '';
    if (name && ![...sel.options].some(o => o.value === name)) sel.appendChild(el('option', { value: name }, name));
    sel.value = name; // sem garantia no modelo: não herda a do anúncio anterior
    $('cr-warranty-time').value = wtime?.value_name || '';
    state.cr.templateTerms = terms.filter(s => s.id !== 'WARRANTY_TYPE' && s.id !== 'WARRANTY_TIME');
    crWarrantyUI();
  }

  function crCollectDraft() {
    const terms = [...(state.cr.templateTerms || [])];
    const wt = $('cr-warranty-type')?.value || '';
    if (wt) {
      terms.push({ id: 'WARRANTY_TYPE', value_name: wt });
      const time = ($('cr-warranty-time')?.value || '').trim();
      if (wt !== 'Sem garantia' && time) terms.push({ id: 'WARRANTY_TIME', value_name: time });
    }
    const fm = crFormatsAll(), first = fm.find(f => f.on) || fm[0];
    return {
      category_id: state.cr.cat?.id || '',
      title: ($('cr-title')?.value || '').trim(),
      price: first.priceVal,
      available_quantity: parseInt($('cr-qty')?.value) || 1,
      listing_type_id: first.lt,
      condition: $('cr-condition')?.value || 'new',
      currency_id: 'BRL', buying_mode: 'buy_it_now',
      shipping: { mode: $('cr-shipping')?.value || 'not_specified', local_pick_up: false, free_shipping: false },
      pictures: state.cr.pictures.map(p => p.id ? { id: p.id, url: p.url } : { url: p.url }),
      attributes: state.cr.cat ? crCollectAttrs() : [],
      sale_terms: terms,
      description: ($('cr-desc')?.value || '').trim(),
    };
  }

  function crCollectSender() {
    const k = state.cr.keyCfg;
    return {
      enabled: !!$('cr-sender-on')?.checked,
      messages: [0, 1, 2, 3].map(i => document.querySelector(`#cr-sender-fields textarea[data-cr-msg="${i}"]`)?.value || ''),
      delay_min: parseInt($('cr-delay-min')?.value) || 30,
      delay_max: parseInt($('cr-delay-max')?.value) || 90,
      product_key: k ? '' : ($('cr-key')?.value || '').trim(),
      // stock of keys (pool / rotating) is carried over from the copied listing
      ...(k ? { key_mode: k.key_mode, key_max_uses: k.key_max_uses, key_max_days: k.key_max_days, key_low_threshold: k.key_low_threshold } : { key_mode: 'fixed' }),
    };
  }

  function crFillSender(s) {
    if (!s) return;
    $('cr-sender-on').checked = !!s.enabled;
    [0, 1, 2, 3].forEach(i => { const ta = document.querySelector(`#cr-sender-fields textarea[data-cr-msg="${i}"]`); if (ta) ta.value = (s.messages || [])[i] || ''; });
    if (s.delay_min != null) $('cr-delay-min').value = s.delay_min;
    if (s.delay_max != null) $('cr-delay-max').value = s.delay_max;
    const pooled = ['pool', 'rotate'].includes(s.key_mode);
    state.cr.keyCfg = pooled ? { key_mode: s.key_mode, key_max_uses: Number(s.key_max_uses) || 0, key_max_days: Number(s.key_max_days) || 0, key_low_threshold: s.key_low_threshold ?? 3 } : null;
    $('cr-key').value = pooled ? '' : (s.product_key || '');
    $('cr-key').disabled = pooled;
    const note = $('cr-key-note');
    if (note) note.textContent = pooled ? `O anúncio de origem usa estoque de chaves (${s.key_mode === 'pool' ? 'uma chave por venda' : 'chave rotativa'}). Os anúncios novos usam o mesmo modo, começando SEM chaves: cadastre as chaves deles em "Chaves" antes de vender. Sem chave, a venda não é atendida automaticamente e você é avisado.` : '';
    crSenderToggle();
  }

  // another seller's listing (or a fresh start): nothing of the previous
  // listing's Auto Sender may carry over — its key belongs to another product
  function crClearSender() {
    state.cr.keyCfg = null;
    if ($('cr-sender-on')) $('cr-sender-on').checked = false;
    document.querySelectorAll('#cr-sender-fields textarea').forEach(t => { t.value = ''; });
    if ($('cr-key')) { $('cr-key').value = ''; $('cr-key').disabled = false; }
    if ($('cr-sender-tpl')) $('cr-sender-tpl').value = '';
    if ($('cr-key-note')) $('cr-key-note').textContent = '';
    crSenderToggle();
  }

  function crSenderToggle() {
    $('cr-sender-fields')?.classList.toggle('dim', !$('cr-sender-on')?.checked);
  }

  function crRenderTplOptions() {
    const sel = $('cr-sender-tpl');
    if (!sel) return;
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, '— preencher com um template —'));
    Object.keys(state.templates || {}).forEach(n => sel.appendChild(el('option', { value: n }, n)));
  }

  function crApplyTpl() {
    const name = $('cr-sender-tpl')?.value;
    const msgs = (state.templates || {})[name];
    if (!msgs) return;
    [0, 1, 2, 3].forEach(i => { const ta = document.querySelector(`#cr-sender-fields textarea[data-cr-msg="${i}"]`); if (ta) ta.value = msgs[i] || ''; });
    $('cr-sender-on').checked = true; crSenderToggle(); crAutosave();
  }

  async function crLoadTemplate(itemId) {
    if (state.cr.busy) { toast('Espere a validação/publicação em andamento terminar', 'warn'); return false; }
    toast('Carregando anúncio…', 'ok', 1500);
    let d;
    try { d = await api(`/api/create/template?item_id=${encodeURIComponent(itemId)}`); }
    catch (e) { toast(e.message, 'err', 7000); return false; }
    d.title = d.title ? `${d.title}`.slice(0, 60) : '';
    // Everything below only happens once the form really holds this listing
    // (crSelectCategory may stop: category closed, lookup error, subcategory to pick).
    return crSelectCategory(d.category_id, [], d, () => {
      // new starting point: the previous list of listings no longer applies
      state.cr.gen++;
      state.cr.vars = []; state.cr.batchSel = new Map(); state.cr.batchRes = {}; state.cr.pendingSender = null;
      if ($('cr-title-options')) $('cr-title-options').innerHTML = '';
      crResult(null);
      const note = el('div', { class: 'msg-vars cr-src' });
      if (d.foreign) {
        crClearSender();
        note.classList.add('foreign');
        note.append(el('strong', {}, `Anúncio de outro vendedor (${d.source_id})`), el('br'),
          el('span', {}, 'Copiamos só os dados do produto: categoria, ficha técnica e título. Fotos, descrição e garantia são dele e não foram copiadas — usar fotos e textos de outro vendedor vai contra as regras do Mercado Livre. Adicione as suas.'));
        if (Number(d.source_price) > 0) note.append(el('br'), el('span', { class: 'muted small' }, `Preço dele: ${crBrl(d.source_price)} (preenchido igual — ajuste o seu).`));
        note.append(el('br'), el('span', { class: 'muted small' }, 'Envio automático: desligado — configure as mensagens e a chave deste produto no passo 6. Dica: "✨ Sugerir nomes com IA" cria títulos seus a partir deste.'));
      } else {
        crFillSender(d.autosender);
        note.append(el('span', {}, `Copiado de ${d.source_id}. Mude o que precisar (título, preço, fotos) antes de publicar — anúncios idênticos concorrem entre si.`));
      }
      crSrcNote(note);
    });
  }

  function crSrcNote(node) {
    const box = $('cr-src-note');
    if (!box) return;
    box.innerHTML = '';
    box.classList.toggle('hidden', !node);
    if (node) box.appendChild(node);
  }

  // "MLB-123…", "MLB123…", a listing link, or a catalog link that names the
  // seller's offer (item_id / wid). Catalog (/p/) and product (MLBU) pages
  // group many listings, so they can't be copied directly.
  function crParseItemId(raw) {
    const s = String(raw || '').trim();
    if (!s) return { error: 'Cole o link ou o código do anúncio (ex.: MLB-1234567890).' };
    let txt = s; try { txt = decodeURIComponent(s); } catch { /* fica como veio */ }
    const up = txt.toUpperCase();
    let m = up.match(/(?:ITEM_ID[:=]|[?&#]WID=)\s*(ML[A-Z])-?(\d{5,})/);
    if (!m && !/\/P\/ML[A-Z]\d+/.test(up)) m = up.match(/(?:^|[^A-Z0-9])(ML[A-Z])-?(\d{5,})(?!\d)/);
    if (!m) {
      if (/\/P\/ML[A-Z]\d+/.test(up)) return { error: 'Esse é um link de página de catálogo (/p/…), que junta vários vendedores. Abra a oferta de um vendedor (o link com MLB-…) e cole aqui.' };
      if (/ML[A-Z]U\d+/.test(up)) return { error: 'Esse link é de uma página de produto (MLBU…), que pode ter vários anúncios. Abra um anúncio específico e cole o link dele.' };
      return { error: 'Não encontrei o código do anúncio (MLB…) nesse texto.' };
    }
    if (m[1] !== 'MLB') return { error: 'Só dá para copiar anúncios do Mercado Livre Brasil (códigos MLB…).' };
    return { id: 'MLB' + m[2] };
  }

  async function crCopyFromLink() {
    const p = crParseItemId($('cr-copy-url')?.value);
    if (p.error) { toast(p.error, 'warn', 7000); return; }
    const btn = $('btn-cr-copy-url'); if (btn) btn.disabled = true;
    try { await crLoadTemplate(p.id); } finally { if (btn) btn.disabled = false; }
  }

  function crRestore(saved) {
    if (state.cr.busy) { toast('Espere a validação/publicação em andamento terminar', 'warn'); return; }
    $('cr-restore')?.classList.add('hidden');
    crSelectCategory(saved.draft.category_id, [], saved.draft, () => {
      state.cr.gen++;
      crFillSender(saved.autosender);
      crApplyBatchState(saved);
      // a batch cut short (closed tab) may have left new listings without their Auto Sender settings
      state.cr.senderSynced = saved.sender_synced !== false;
      if (!state.cr.senderSynced) setTimeout(async () => {
        const items = Object.values(state.cr.batchRes).filter(r => r.status === 'ok' && /^MLB\d+$/.test(String(r.id))).map(r => ({ id: r.id, title: r.title }));
        const sender = crCollectSender();
        if (!items.length || !(sender.enabled || sender.product_key || sender.messages.some(m => String(m).trim()))) { state.cr.senderSynced = true; return; }
        const res = await crSaveSender(items, sender);
        if (res !== 'fail') { toast(`Envio automático conferido nos ${items.length} anúncio(s) já criados por este rascunho`, 'ok', 5000); crSaveDraft(); }
        else toast('Não consegui salvar o envio automático dos anúncios já criados — confira em Produtos', 'err', 8000);
      }, 0);
    });
  }

  // formats, prices, title variations, ticked/unticked rows and — so that a
  // reload can never publish them again — the listings already created
  function crApplyBatchState(saved) {
    const f = saved && saved.formats;
    if (f) {
      $('cr-fmt-classic').checked = !!f.classic?.on; $('cr-price').value = f.classic?.price ?? '';
      $('cr-fmt-premium').checked = !!f.premium?.on; $('cr-price-premium').value = f.premium?.price ?? '';
    }
    state.cr.vars = Array.isArray(saved?.title_vars) ? saved.title_vars.map(x => String(x ?? '')).slice(0, CR_MAX_VARS) : [];
    const sel = saved?.batch_sel && typeof saved.batch_sel === 'object' ? Object.entries(saved.batch_sel)
      : (Array.isArray(saved?.batch_off) ? saved.batch_off.map(k => [k, false]) : []);
    state.cr.batchSel = new Map(sel.map(([k, v]) => [String(k), !!v]));
    state.cr.batchRes = {};
    for (const [k, r] of Object.entries(saved?.batch_done || {})) {
      if (!r || !['ok', 'unknown'].includes(r.status)) continue;
      state.cr.batchRes[k] = { status: r.status, id: String(r.id || ''), permalink: String(r.permalink || ''), live: String(r.live || ''),
        title: String(r.title || ''), lt: String(r.lt || ''), price: Number(r.price) || 0,
        msg: r.status === 'unknown' ? 'sem resposta na última tentativa — confira em Produtos se ele foi criado antes de tentar de novo' : '' };
    }
  }

  function crSaveDraft() {
    clearTimeout(state.cr.saveT);
    if (!state.cr.cat) return;
    const done = {}, sel = Object.fromEntries(state.cr.batchSel);
    for (const [k, r] of Object.entries(state.cr.batchRes)) {
      // a request in flight is saved as "no answer" (and unticked): if the tab
      // dies now, the listing may still have been created
      const st = r.status === 'publishing' ? 'unknown' : r.status;
      if (r.status === 'publishing') sel[k] = false;
      if (['ok', 'unknown'].includes(st)) done[k] = { status: st, id: r.id || '', permalink: r.permalink || '', live: r.live || '', title: r.title || '', lt: r.lt || '', price: r.price || 0 };
    }
    try {
      localStorage.setItem(CR_DRAFT_KEY, JSON.stringify({ saved_at: Date.now(), draft: crCollectDraft(), autosender: crCollectSender(),
        formats: { classic: { on: !!$('cr-fmt-classic')?.checked, price: $('cr-price')?.value || '' }, premium: { on: !!$('cr-fmt-premium')?.checked, price: $('cr-price-premium')?.value || '' } },
        title_vars: state.cr.vars, batch_sel: sel, batch_done: done, sender_synced: state.cr.senderSynced !== false }));
      const s = $('cr-draft-status'); if (s) s.textContent = `rascunho salvo ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    } catch { /* armazenamento cheio/indisponível */ }
  }
  function crAutosave() {
    clearTimeout(state.cr.saveT);
    state.cr.saveT = setTimeout(crSaveDraft, 800);
  }

  function crFormatsAll() {
    return CR_FMT.map(f => ({ ...f, on: !!$(f.check)?.checked, priceVal: crNum($(f.price)?.value) }));
  }
  function crFormatUI() {
    for (const f of crFormatsAll()) $(f.row)?.classList.toggle('off', !f.on);
  }

  // one fee lookup per category + price (cached; concurrent calls share it)
  async function crFeeAt(price) {
    const key = `${state.cr.cat?.id}|${Number(price).toFixed(2)}`;
    if (!state.cr.feeCache.has(key)) {
      const p = api(`/api/create/fees?price=${Number(price).toFixed(2)}&category_id=${encodeURIComponent(state.cr.cat?.id || '')}`);
      state.cr.feeCache.set(key, p);
      p.catch(() => state.cr.feeCache.delete(key));
    }
    return state.cr.feeCache.get(key);
  }

  async function crFees() {
    const box = $('cr-fees');
    if (!box) return;
    const seq = ++state.cr.feeSeq;
    const fm = crFormatsAll();
    const netBy = {};
    const lines = {};
    if (state.cr.cat) {
      for (const f of fm) {
        if (!f.on || !(f.priceVal > 0)) continue;
        try {
          const x = (await crFeeAt(f.priceVal) || []).find(z => z.listing_type_id === f.lt);
          if (!x) { lines[f.lt] = 'tarifa não informada pelo ML'; continue; }
          netBy[f.lt] = { price: f.priceVal, net: x.net };
          lines[f.lt] = `Tarifa ${crBrl(x.fee)}${x.percentage ? ` (${String(x.percentage).replace('.', ',')}%${x.fixed_fee ? ' + ' + crBrl(x.fixed_fee) : ''})` : ''} · Você recebe ${crBrl(x.net)}`;
        } catch (e) { lines[f.lt] = 'não consegui consultar a tarifa'; }
      }
    }
    if (seq !== state.cr.feeSeq) return; // a newer calculation is on its way
    state.cr.netBy = netBy;
    for (const f of fm) { const e = $(f.fee); if (e) e.textContent = lines[f.lt] || ''; }
    box.innerHTML = '';
    if (Object.keys(lines).length) box.appendChild(el('div', {}, 'Valores estimados pelo Mercado Livre, antes de impostos e frete.'));
    const nc = netBy.gold_special?.net, np = netBy.gold_pro?.net;
    if (nc != null && np != null) {
      const d = np - nc;
      box.appendChild(el('div', {}, Math.abs(d) < 0.01 ? 'Você recebe o mesmo valor nos dois formatos.'
        : `No Premium você recebe ${crBrl(Math.abs(d))} ${d > 0 ? 'a mais' : 'a menos'} por venda que no Clássico.`));
    }
    crRenderBatch();
  }

  // Premium price that leaves the same net as the Clássico. Fees are a
  // percentage plus, on cheap items, a fixed amount that disappears above a
  // price threshold — so the net jumps there. The net only grows with the
  // price, so after the estimate the cheapest price that reaches the target is
  // found by bisection between the last price that fell short and the first
  // that reached it, every point checked with Mercado Livre's own fee table.
  async function crMatchNet() {
    if (!state.cr.cat) return;
    const pc = crNum($('cr-price')?.value);
    if (!(pc > 0)) { toast('Informe primeiro o preço do Clássico', 'warn'); return; }
    const btn = $('btn-cr-match-net'), label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Calculando…'; }
    try {
      const fc = (await crFeeAt(pc) || []).find(f => f.listing_type_id === 'gold_special');
      if (!fc) { toast('O Mercado Livre não informou a tarifa do Clássico', 'warn'); return; }
      const target = fc.net, tried = [];
      const netAt = async p => { const fp = (await crFeeAt(p) || []).find(f => f.listing_type_id === 'gold_pro'); if (fp) tried.push({ price: p, net: fp.net }); return fp; };
      let pp = pc;
      for (let i = 0; i < 6; i++) {
        const fp = await netAt(pp);
        if (!fp) break;
        if (fp.net >= target - 0.005) break;
        const pct = (Number(fp.percentage) || 0) / 100;
        let next = pct > 0 && pct < 0.9 ? (target + (Number(fp.fixed_fee) || 0)) / (1 - pct) : pp + (target - fp.net) * 1.25;
        next = Math.ceil(next * 100 - 1e-6) / 100;
        if (next <= pp || tried.some(t => Math.abs(t.price - next) < 0.005)) next = Math.ceil((pp * 1.1) * 100) / 100;
        pp = next;
      }
      const reach = () => tried.filter(t => t.net >= target - 0.005).sort((a, b) => a.price - b.price)[0];
      const short = () => tried.filter(t => t.net < target - 0.005).sort((a, b) => b.price - a.price)[0];
      let hi = reach(), lo = short();
      for (let i = 0; i < 14 && hi && lo && hi.price - lo.price > 0.011; i++) {
        const mid = Math.round((lo.price + hi.price) / 2 * 100) / 100;
        if (mid <= lo.price || mid >= hi.price) break;
        const fp = await netAt(mid);
        if (!fp) break;
        if (fp.net >= target - 0.005) hi = { price: mid, net: fp.net }; else lo = { price: mid, net: fp.net };
      }
      const pick = hi;
      if (!pick) { toast('Não consegui calcular o preço do Premium — preencha à mão', 'warn'); return; }
      $('cr-price-premium').value = pick.price.toFixed(2);
      $('cr-fmt-premium').checked = true;
      crFormatUI();
      await crFees(); crOnEdit();
      const diff = pick.net - target;
      toast(Math.abs(diff) < 0.05
        ? `Premium a ${crBrl(pick.price)}: você recebe ${crBrl(pick.net)}, igual ao Clássico`
        : `Premium a ${crBrl(pick.price)}: você recebe ${crBrl(pick.net)} — ${crBrl(diff)} a mais que no Clássico (${crBrl(target)}). Por causa da faixa de tarifa do Mercado Livre, é o menor preço que não fica abaixo.`, 'ok', 8000);
    } catch (e) { toast(e.message, 'err'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
  }

  // ── títulos: principal + variações ──
  function crTitles() {
    const seen = new Set(), out = [];
    for (const t of [$('cr-title')?.value || '', ...state.cr.vars]) {
      const v = String(t || '').replace(/\s+/g, ' ').trim(), k = crFold(v);
      if (!v || seen.has(k)) continue;
      seen.add(k); out.push(v);
    }
    return out;
  }
  function crRenderVars() {
    const box = $('cr-title-vars');
    if (!box) return;
    box.innerHTML = '';
    const max = $('cr-title')?.maxLength > 0 ? $('cr-title').maxLength : 60;
    state.cr.vars.forEach((t, i) => {
      const row = el('div', { class: 'cr-var' });
      const inp = el('input', { class: 'cr-var-input', maxlength: String(max), placeholder: 'Outro jeito de chamar o mesmo produto', 'aria-label': `Variação de título ${i + 1}` });
      inp.value = t;
      const cnt = el('span', { class: 'muted small cr-var-count' }, `${t.length}/${max}`);
      inp.addEventListener('input', () => { state.cr.vars[i] = inp.value; cnt.textContent = `${inp.value.length}/${max}`; });
      row.append(inp, cnt, el('button', { class: 'icon-btn', title: 'Remover variação', 'aria-label': 'Remover variação',
        onclick: () => { state.cr.vars.splice(i, 1); crRenderVars(); crOnEdit(); } }, '✕'));
      box.appendChild(row);
    });
  }
  function crAddVar(text) {
    if (state.cr.vars.length >= CR_MAX_VARS) { toast(`Até ${CR_MAX_VARS} variações de título`, 'warn'); return false; }
    const t = String(text || '').trim();
    if (t && crTitles().some(x => crFold(x) === crFold(t))) { toast('Esse título já está na lista', 'warn'); return false; }
    state.cr.vars.push(t);
    crRenderVars(); crOnEdit();
    if (!t) $('cr-title-vars')?.querySelector('.cr-var:last-child input')?.focus();
    return true;
  }

  // ── lista de anúncios a criar: títulos × formatos ──
  const crKey = (lt, title) => `${lt}|${crFold(title)}`;
  const crIsMade = r => !!r && (r.status === 'ok' || r.status === 'unknown'); // created, or maybe created
  // formats that already have a listing created (or maybe created) from this draft
  function crMadeFormats() {
    const s = new Set();
    for (const r of Object.values(state.cr.batchRes)) if (crIsMade(r) && r.lt) s.add(r.lt);
    return s;
  }
  // Rows = titles × formats. A NEW row in a format that already has a listing
  // from this draft starts unticked (editing the title after a partial batch
  // must not silently create a second Clássico). Created rows stay listed —
  // even after their title changed — so they can't be forgotten or redone.
  function crVariants() {
    const fm = crFormatsAll().filter(f => f.on), out = [], seen = new Set(), made = crMadeFormats();
    for (const t of crTitles()) for (const f of fm) {
      const key = crKey(f.lt, t);
      seen.add(key);
      const res = state.cr.batchRes[key];
      const byDefault = !(made.has(f.lt) && !res);
      const on = state.cr.batchSel.has(key) ? state.cr.batchSel.get(key) : byDefault;
      out.push({ key, title: t, lt: f.lt, name: f.name, price: f.priceVal, on, res, heldBack: !byDefault && !state.cr.batchSel.has(key) });
    }
    for (const [key, res] of Object.entries(state.cr.batchRes)) {
      if (seen.has(key) || !crIsMade(res) || !res.lt) continue;
      const f = CR_FMT.find(x => x.lt === res.lt);
      out.push({ key, title: res.title || '(título anterior)', lt: res.lt, name: f ? f.name : res.lt, price: res.price || 0, on: res.status === 'ok', res, orphan: true });
    }
    return out;
  }
  // rows that a click on Validar / Publicar would send
  const crPending = all => all.filter(v => v.on && !v.orphan && v.res?.status !== 'ok');
  function crDupWarning(newRows) {
    const per = {};
    const add = (lt, key) => { (per[lt] = per[lt] || new Set()).add(key); };
    let fromMade = false;
    for (const [k, r] of Object.entries(state.cr.batchRes)) if (crIsMade(r) && r.lt) add(r.lt, k);
    for (const v of newRows) { if (per[v.lt] && !per[v.lt].has(v.key)) fromMade = true; add(v.lt, v.key); }
    const dup = CR_FMT.filter(f => (per[f.lt]?.size || 0) > 1).map(f => f.name);
    if (!dup.length) return '';
    const where = dup.length > 1 ? 'no mesmo formato (Clássico e Premium)' : `no ${dup[0]}`;
    return `Mais de um anúncio do mesmo produto ${where}${fromMade ? ', contando os que você já criou aqui' : ''}, mudando só o título: o Mercado Livre considera isso anúncio duplicado e pode desativá-los, mantendo só o de maior exposição. Já ter o mesmo produto em Clássico e em Premium costuma ser aceito, porque as condições de pagamento são diferentes.`;
  }
  function crBatchProblem(vs) {
    if (!crFormatsAll().some(f => f.on)) return 'Marque pelo menos um formato: Clássico ou Premium.';
    if (!vs.length) return 'Nenhum anúncio marcado na lista do passo 7.';
    if (vs.length > CR_MAX_BATCH) return `Máximo de ${CR_MAX_BATCH} anúncios por vez — desmarque ${vs.length - CR_MAX_BATCH} na lista do passo 7.`;
    const noPrice = [...new Set(vs.filter(v => !(v.price > 0)).map(v => v.name))];
    if (noPrice.length) return `Informe o preço do ${noPrice.join(' e do ')}.`;
    if (vs.some(v => v.title.length < 5)) return 'Cada título precisa ter pelo menos 5 letras.';
    const max = $('cr-title')?.maxLength > 0 ? $('cr-title').maxLength : 60;
    const long = vs.find(v => v.title.length > max);
    if (long) return `O título "${long.title.slice(0, 40)}…" passa de ${max} caracteres.`;
    return '';
  }
  function crErrText(res) {
    return (res?.errors || []).map(e => e.pt || e.message || e.code).filter(Boolean).slice(0, 2).join(' · ') || 'recusado pelo Mercado Livre';
  }
  function crStatusNode(res) {
    if (!res) return el('span', { class: 'muted' }, 'a criar');
    if (res.status === 'publishing') return el('span', { class: 'muted' }, 'publicando…');
    if (res.status === 'valid') return el('span', { class: 'cr-st-ok' }, '✓ validado');
    if (res.status === 'invalid') return el('span', { class: 'cr-st-err' }, '✗ ' + (res.msg || 'recusado'));
    if (res.status === 'error') return el('span', { class: 'cr-st-err' }, '✗ ' + (res.msg || 'erro'));
    if (res.status === 'unknown') return el('span', { class: 'cr-st-warn' }, '⚠ ' + (res.msg || 'sem resposta'));
    if (res.status === 'ok') {
      const s = el('span', { class: 'cr-st-ok' }, `✓ ${res.id}${res.live === 'paused' ? ' (pausado)' : ''} `);
      const href = crSafeUrl(res.permalink);
      if (href) s.appendChild(el('a', { href, target: '_blank', rel: 'noopener' }, 'abrir ↗'));
      return s;
    }
    return el('span');
  }
  // net for a row only if it was computed for this exact price
  function crNetFor(v) {
    const nb = state.cr.netBy[v.lt];
    return nb && v.price > 0 && Math.abs(nb.price - v.price) < 0.005 ? nb.net : null;
  }
  function crRenderBatch() {
    const box = $('cr-batch');
    if (!box) return;
    const all = crVariants(), live = all.filter(v => !v.orphan), pend = crPending(all);
    const nT = crTitles().length, nF = crFormatsAll().filter(f => f.on).length;
    const done = all.filter(v => v.res?.status === 'ok').length;
    const cnt = $('cr-batch-count');
    if (cnt) cnt.textContent = live.length > 1 || done ? `→ ${pend.length} anúncio(s) a criar${done ? ` · ${done} já criado(s)` : ''} (${nT} título${nT > 1 ? 's' : ''} × ${nF} formato${nF > 1 ? 's' : ''}) — confira a lista no passo 7.` : '';
    box.innerHTML = '';
    if (!all.length) { box.appendChild(el('div', { class: 'muted small' }, nF ? 'Escreva o título no passo 2.' : 'Marque pelo menos um formato (Clássico ou Premium) no passo 2.')); return; }
    const t = el('table', { class: 'table cr-batch-table' });
    const hr = el('tr');
    ['', 'Título', 'Formato', 'Preço', 'Você recebe', 'Situação'].forEach((h, i) => hr.appendChild(el('th', { class: i === 3 || i === 4 ? 'num' : '' }, h)));
    t.appendChild(el('thead', {}, hr));
    const tb = el('tbody');
    for (const v of all) {
      const res = v.res;
      const tr = el('tr', { class: (v.on ? '' : 'off') + (v.orphan ? ' orphan' : '') });
      const cb = el('input', { type: 'checkbox', 'aria-label': `Criar "${v.title}" no ${v.name}` });
      cb.checked = v.on;
      if (v.orphan || res?.status === 'ok' || res?.status === 'publishing' || state.cr.busy) cb.disabled = true;
      cb.addEventListener('change', () => { state.cr.batchSel.set(v.key, cb.checked); crRenderBatch(); crAutosave(); });
      const net = v.orphan ? null : crNetFor(v);
      let st = crStatusNode(res);
      if (!res && v.heldBack) st = el('span', { class: 'muted' }, `já existe um ${v.name} criado aqui — marque só se quiser outro`);
      tr.append(el('td', {}, cb), el('td', { class: 'cr-batch-title' }, v.title), el('td', {}, v.name),
        el('td', { class: 'num' }, v.price > 0 ? crBrl(v.price) : '—'),
        el('td', { class: 'num' }, net != null ? crBrl(net) : '—'),
        el('td', { class: 'cr-batch-st' }, st));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    box.appendChild(el('div', { class: 'table-wrap' }, t));
    if (pend.length > CR_MAX_BATCH) box.appendChild(el('div', { class: 'cr-warn err' }, `Máximo de ${CR_MAX_BATCH} anúncios por vez — desmarque ${pend.length - CR_MAX_BATCH}.`));
    const dup = crDupWarning(pend);
    if (dup) box.appendChild(el('div', { class: 'cr-warn' }, '⚠ ' + dup));
  }

  // only one of Validar / Publicar at a time, and nothing that changes the
  // starting point (another listing, reset, draft) while it runs
  function crBusyUI() {
    const b = state.cr.busy;
    ['btn-cr-publish', 'btn-cr-publish-paused', 'btn-cr-validate', 'btn-cr-reset', 'btn-cr-copy-url'].forEach(id => { const x = $(id); if (x) x.disabled = !!b; });
    const v = $('btn-cr-validate');
    if (v) v.textContent = b === 'validate' ? 'Validando…' : '✔ Validar no Mercado Livre';
    crRenderBatch();
  }

  // ── Fotos: redimensiona no navegador (máx. 1920 px, JPEG) e envia ao ML ──
  async function crResize(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('não consegui abrir a imagem')); i.src = url; });
      let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const small = Math.max(w, h) < 500;
      const scale = Math.min(1, 1920 / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG transparente vira fundo branco
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
      return { blob, small };
    } finally { URL.revokeObjectURL(url); }
  }

  async function crAddPhotos(files) {
    const max = Math.min(10, state.cr.cat?.settings?.max_pictures_per_item || 10);
    const room = max - state.cr.pictures.length;
    if (room <= 0) { toast(`Máximo de ${max} fotos`, 'warn'); return; }
    const list = files.filter(f => /^image\//.test(f.type)).slice(0, room);
    if (!list.length) { toast('Escolha arquivos de imagem (JPG ou PNG)', 'warn'); return; }
    for (const f of list) {
      const slot = { id: '', url: '', uploading: true };
      state.cr.pictures.push(slot); crRenderPhotos();
      try {
        const { blob, small } = await crResize(f);
        if (small) toast(`"${f.name}" é pequena (menos de 500 px) — pode ficar sem zoom no anúncio`, 'warn', 5000);
        const fd = new FormData();
        fd.append('file', blob, (f.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg');
        const r = await api('/api/create/picture', { method: 'POST', body: fd });
        slot.id = r.id; slot.url = r.url; slot.uploading = false;
      } catch (e) {
        state.cr.pictures.splice(state.cr.pictures.indexOf(slot), 1);
        toast(`Foto "${f.name}": ${e.message}`, 'err', 6000);
      }
      crRenderPhotos(); crAutosave();
    }
  }

  function crAddPhotoUrl() {
    const url = prompt('Endereço (URL) da foto — precisa começar com https://');
    if (!url) return;
    if (!/^https:\/\/\S+$/i.test(url.trim())) { toast('URL inválida', 'warn'); return; }
    state.cr.pictures.push({ id: '', url: url.trim() });
    crRenderPhotos(); crAutosave();
  }

  function crRenderPhotos() {
    const box = $('cr-photos');
    if (!box) return;
    box.innerHTML = '';
    state.cr.pictures.forEach((p, i) => {
      const card = el('div', { class: 'cr-photo' + (i === 0 ? ' cover' : '') });
      if (p.uploading) card.appendChild(el('div', { class: 'cr-photo-wait' }, 'enviando…'));
      else card.appendChild(el('img', { src: p.url || '', alt: `foto ${i + 1}`, loading: 'lazy' }));
      if (i === 0) card.appendChild(el('span', { class: 'cr-cover-tag' }, 'capa'));
      const acts = el('div', { class: 'cr-photo-acts' });
      if (i > 0) acts.appendChild(el('button', { class: 'icon-btn', title: 'Mover para a esquerda', onclick: () => { const a = state.cr.pictures; [a[i - 1], a[i]] = [a[i], a[i - 1]]; crRenderPhotos(); crAutosave(); } }, '◀'));
      acts.appendChild(el('button', { class: 'icon-btn', title: 'Remover', onclick: () => { state.cr.pictures.splice(i, 1); crRenderPhotos(); crAutosave(); } }, '✕'));
      card.appendChild(acts);
      box.appendChild(card);
    });
    const c = $('cr-photo-count'); if (c) c.textContent = `${state.cr.pictures.filter(p => !p.uploading).length} foto(s)`;
  }

  function crResult(node) {
    const box = $('cr-result');
    if (!box) return;
    box.innerHTML = '';
    if (node) box.appendChild(node);
  }

  function crShowErrors(res) {
    const wrap = el('div', { class: 'test-result err' });
    wrap.appendChild(el('strong', {}, 'O Mercado Livre apontou problemas:'));
    const ul = el('ul', { class: 'cr-errors' });
    (res.errors || []).forEach(e => ul.appendChild(el('li', {}, e.pt || e.message || e.code)));
    wrap.appendChild(ul);
    (res.warnings || []).forEach(w => wrap.appendChild(el('div', { class: 'muted small' }, `Aviso: ${w.message}`)));
    return wrap;
  }

  function crLocalCheck(d) {
    if (!d.category_id) return 'Escolha a categoria.';
    if (d.title.length < 5) return 'Escreva o título (mínimo 5 letras).';
    if (!(d.price > 0)) return 'Informe o preço.';
    if (state.cr.pictures.some(p => p.uploading)) return 'Espere as fotos terminarem de enviar.';
    if (!d.pictures.length) return 'Adicione pelo menos uma foto.';
    const missing = (state.cr.cat?.attributes || []).filter(a => a.required && !d.attributes.some(x => x.id === a.id)).map(a => a.name);
    if (missing.length) return `Preencha: ${missing.join(', ')}.`;
    return '';
  }

  // Problems before sending anything: the shared data, then the list itself.
  function crPreCheck(base, all) {
    const pend = crPending(all);
    if (!pend.length && all.some(v => v.res?.status === 'ok')) return { done: true };
    return { prob: crLocalCheck(base) || crBatchProblem(pend), pend };
  }

  async function crValidate() {
    if (state.cr.busy) return false;
    clearTimeout(state.cr.feeT);
    const base = crCollectDraft();
    const pc = crPreCheck(base, crVariants());
    if (pc.done) { crResult(el('div', { class: 'test-result ok' }, 'Os anúncios marcados já foram criados.')); return true; }
    if (pc.prob) { crResult(el('div', { class: 'test-result err' }, pc.prob)); return false; }
    const vs = pc.pend;
    state.cr.busy = 'validate'; crBusyUI();
    const BR = state.cr.batchRes, gen = state.cr.gen;
    const warnings = new Set();
    try {
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        const r = await api('/api/create/validate', { method: 'POST', body: { draft: { ...base, title: v.title, listing_type_id: v.lt, price: v.price } } });
        if (gen !== state.cr.gen) return false; // the starting point changed meanwhile
        (r.warnings || []).forEach(w => w && w.message && warnings.add(w.message));
        // a validation never overwrites a listing that exists (or may exist)
        const cur = BR[v.key];
        if (!cur || ['valid', 'invalid', 'error'].includes(cur.status)) BR[v.key] = r.ok ? { status: 'valid' } : { status: 'invalid', msg: crErrText(r) };
        crRenderBatch();
        if (!r.ok) {
          // problems in the shared data (photos, technical sheet) repeat in every listing: stop at the first
          const node = crShowErrors(r);
          if (vs.length > 1) node.prepend(el('div', { class: 'small', style: 'margin-bottom:6px' }, `Problema em "${v.title}" (${v.name}) — ${i ? `${i} anterior(es) validado(s); ` : ''}corrija e valide de novo.`));
          crResult(node);
          return false;
        }
      }
      const ok = el('div', { class: 'test-result ok' }, vs.length > 1 ? `✓ Tudo certo — o Mercado Livre aceitaria os ${vs.length} anúncios.` : '✓ Tudo certo — o Mercado Livre aceitaria este anúncio.');
      warnings.forEach(w => ok.appendChild(el('div', { class: 'muted small' }, `Aviso: ${w}`)));
      crResult(ok);
      return true;
    } catch (e) { crResult(el('div', { class: 'test-result err' }, e.message)); return false; }
    finally { state.cr.busy = ''; crBusyUI(); }
  }

  // Did this failed call certainly NOT create the listing? Only an explicit
  // refusal counts; a lost answer or a server error may have come after
  // Mercado Livre created it — those become "sem resposta", never "retry".
  function crCertainFailure(e) {
    if (e.network || e.data?.uncertain || Number(e.data?.status) >= 500) return false;
    if (e.status === 429 || e.data?.status === 429 || e.status === 401) return true;
    return e.status >= 400 && e.status < 500 && !!e.data && (Array.isArray(e.data.errors) || e.data.ok === false);
  }

  async function crPublish(status) {
    if (state.cr.busy) return;
    clearTimeout(state.cr.feeT);
    await crFees(); // "você recebe" in the confirmation must match the prices on screen
    const base = crCollectDraft();
    const all = crVariants();
    const pc = crPreCheck(base, all);
    if (pc.done) { toast('Os anúncios marcados já foram criados', 'warn'); return; }
    if (pc.prob) { crResult(el('div', { class: 'test-result err' }, pc.prob)); return; }
    const vs = pc.pend;
    const sender = crCollectSender();
    const paused = status === 'paused';
    const node = el('div', { class: 'cr-confirm' });
    node.appendChild(el('p', {}, vs.length > 1 ? `Serão criados ${vs.length} anúncios:` : 'Será criado 1 anúncio:'));
    const ul = el('ul', { class: 'cr-confirm-list' });
    vs.forEach(v => { const n = crNetFor(v); ul.appendChild(el('li', {}, `${v.name} · ${crBrl(v.price)}${n != null ? ` (você recebe ~${crBrl(n)})` : ''} — "${v.title}"`)); });
    node.appendChild(ul);
    node.appendChild(el('p', {}, `Estoque: ${base.available_quantity} em cada. ${paused ? 'Criados PAUSADOS — você ativa quando quiser.' : 'Publicados ATIVOS — já podem receber vendas.'}`));
    node.appendChild(el('p', {}, sender.enabled ? 'Envio automático: LIGADO nos anúncios novos.' : 'Envio automático: desligado.'));
    const usesKey = sender.messages.some(m => String(m).includes('{key}'));
    if (sender.enabled && usesKey && sender.key_mode !== 'fixed')
      node.appendChild(el('p', { class: 'cr-warn' }, '🔑 Este produto usa estoque de chaves: os anúncios novos começam SEM chaves. Cadastre as chaves deles em "Chaves" antes de vender — sem chave, a venda não é atendida automaticamente (você é avisado).'));
    else if (sender.enabled && usesKey && !sender.product_key)
      node.appendChild(el('p', { class: 'cr-warn' }, '🔑 As mensagens usam {key}, mas a chave está vazia: nada será enviado aos compradores até você preencher a chave (no passo 6 ou depois, em Produtos).'));
    const dup = crDupWarning(vs);
    if (dup) node.appendChild(el('p', { class: 'cr-warn' }, '⚠ ' + dup));
    const unknown = vs.filter(v => v.res?.status === 'unknown').length;
    if (unknown) node.appendChild(el('p', { class: 'cr-warn' }, unknown === 1
      ? '⚠ Um deles ficou sem resposta na tentativa anterior e pode já ter sido criado. Confira em Produtos antes de continuar.'
      : `⚠ ${unknown} deles ficaram sem resposta na tentativa anterior e podem já ter sido criados. Confira em Produtos antes de continuar.`));
    const okLabel = paused ? (vs.length > 1 ? `Publicar ${vs.length} pausados` : 'Publicar pausado') : (vs.length > 1 ? `Publicar ${vs.length}` : 'Publicar');
    if (state.cr.busy || !await confirmNode(paused ? 'Publicar pausado' : 'Publicar agora', node, okLabel)) return;
    if (state.cr.busy) return;

    state.cr.busy = 'publish'; crBusyUI();
    const BR = state.cr.batchRes, gen = state.cr.gen; // a new starting point can't receive these results
    // everything confirmed stays chosen: a stop (pause, closed tab) can't "unpick" it later
    vs.forEach(v => state.cr.batchSel.set(v.key, true));
    const wantsSender = !!(sender.enabled || sender.product_key || sender.messages.some(m => String(m).trim()));
    if (wantsSender) state.cr.senderSynced = false;
    crResult(el('div', { class: 'muted small' }, vs.length > 1 ? `Publicando ${vs.length} anúncios no Mercado Livre, um de cada vez…` : 'Publicando no Mercado Livre…'));
    const created = [], failed = [];
    let stopped = '';
    try {
      for (let i = 0; i < vs.length; i++) {
        if (gen !== state.cr.gen) { stopped = 'Publicação interrompida: você começou outro anúncio.'; break; }
        const v = vs[i];
        const prevUnknown = BR[v.key]?.status === 'unknown' ? BR[v.key] : null;
        BR[v.key] = { status: 'publishing', title: v.title, lt: v.lt, price: v.price };
        crRenderBatch();
        crSaveDraft(); // saved as "no answer" while in flight: a closed tab can't lead to a blind resend
        try {
          // each listing carries its Auto Sender settings (a batch cut short still leaves every created one configured)
          const r = await api('/api/create/publish', { method: 'POST', body: { draft: { ...base, title: v.title, listing_type_id: v.lt, price: v.price }, status, ...(wantsSender ? { autosender: sender } : {}) } });
          BR[v.key] = { status: 'ok', id: r.id, permalink: r.permalink || '', live: r.status, warnings: r.warnings || [], title: v.title, lt: v.lt, price: v.price };
          created.push({ v, r });
        } catch (e) {
          if (crCertainFailure(e)) {
            const res = e.data && (e.data.errors || e.data.warnings) ? e.data : { errors: [{ message: e.message }] };
            BR[v.key] = prevUnknown || { status: 'error', msg: crErrText(res), res, title: v.title, lt: v.lt, price: v.price };
            if (e.status === 429 || e.data?.status === 429) stopped = 'O Mercado Livre pediu uma pausa (limite de requisições). Os que faltaram continuam marcados — publique de novo em alguns minutos.';
          } else {
            // maybe created: unticked, so a later "Publicar" doesn't resend it unless you tick it again
            BR[v.key] = { status: 'unknown', msg: 'sem resposta — confira em Produtos se ele foi criado; só marque de novo se não foi', title: v.title, lt: v.lt, price: v.price };
            if (gen === state.cr.gen) state.cr.batchSel.set(v.key, false);
          }
          failed.push({ v, e });
        }
        if (gen === state.cr.gen) { crRenderBatch(); crSaveDraft(); } // created ones are saved at once: a reload can't redo them
        if (stopped) break;
        if (i < vs.length - 1) await new Promise(r => setTimeout(r, CR_GAP_MS));
      }
      // Auto Sender settings once more for all new listings in a single write —
      // reconciles any per-listing save lost to KV's eventual consistency
      let senderRes = '';
      if (created.length && wantsSender) senderRes = await crSaveSender(created.map(c => ({ id: c.r.id, title: c.v.title })), sender);
      else if (!created.length) state.cr.senderSynced = true;
      if (created.length) {
        toast(created.length > 1 ? `${created.length} anúncios publicados!` : 'Anúncio publicado!', 'ok');
        state.products = []; // força recarregar a lista com os anúncios novos
        api('/api/products').then(p => { state.products = p; crRenderCopyList(); }).catch(() => {});
      }
      if (gen !== state.cr.gen) { if (stopped) toast(`${stopped} ${created.length} criado(s) antes disso.`, 'warn', 8000); return; }
      crResult(crBatchResultNode(created, failed, stopped, senderRes, sender));
      if (!failed.length && !stopped && !crPending(crVariants()).length) localStorage.removeItem(CR_DRAFT_KEY);
      else crSaveDraft();
    } finally { state.cr.busy = ''; crBusyUI(); }
  }

  async function crSaveSender(items, sender) {
    try {
      await api('/api/create/sender_bulk', { method: 'POST', body: { items, autosender: sender } });
      state.cr.pendingSender = null;
      state.cr.senderSynced = true;
      return sender.enabled ? 'on' : 'saved';
    } catch (e) { state.cr.pendingSender = { items, sender }; return 'fail'; }
  }

  function crBatchResultNode(created, failed, stopped, senderRes, sender) {
    const box = el('div', { class: 'test-result ' + (failed.length || stopped || senderRes === 'fail' ? (created.length ? 'warn' : 'err') : 'ok') });
    if (created.length === 1 && !failed.length) {
      const r = created[0].r;
      box.append(el('strong', {}, `✓ Anúncio criado: ${r.id} (${r.status === 'paused' ? 'pausado' : 'ativo'})`), el('br'));
      const href = crSafeUrl(r.permalink);
      if (href) box.appendChild(el('a', { href, target: '_blank', rel: 'noopener' }, 'Abrir no Mercado Livre ↗'));
    } else if (created.length) {
      box.appendChild(el('strong', {}, `✓ ${created.length} anúncio(s) criado(s)`));
      const ul = el('ul', { class: 'cr-errors' });
      created.forEach(({ v, r }) => {
        const li = el('li', {}, `${r.id} · ${v.name} · ${crBrl(v.price)} — ${v.title} `);
        const href = crSafeUrl(r.permalink);
        if (href) li.appendChild(el('a', { href, target: '_blank', rel: 'noopener' }, 'abrir ↗'));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    const warns = new Set();
    created.forEach(({ r }) => (r.warnings || []).forEach(w => w && w.message && warns.add(w.message)));
    warns.forEach(w => box.appendChild(el('div', { class: 'small', style: 'color:var(--warning);margin-top:6px' }, `⚠ ${w}`)));
    if (senderRes === 'on') box.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' }, created.length > 1 ? 'Envio automático ativado nos anúncios novos.' : 'Envio automático ativado para este anúncio.'));
    if (senderRes === 'fail') {
      const w = el('div', { class: 'small', style: 'margin-top:8px' }, '⚠ Os anúncios foram criados, mas não consegui salvar o envio automático deles. ');
      w.appendChild(el('button', { class: 'btn ghost sm', onclick: async ev => {
        const b = ev.currentTarget; b.disabled = true;
        const p = state.cr.pendingSender;
        const res = p ? await crSaveSender(p.items, p.sender) : 'fail';
        if (res === 'fail') { b.disabled = false; toast('Ainda não consegui salvar — tente de novo em instantes', 'err'); }
        else { w.textContent = '✓ Envio automático salvo nos anúncios novos.'; }
      } }, 'Tentar de novo'));
      box.appendChild(w);
    }
    if (failed.length) {
      box.appendChild(el('div', { class: 'small', style: 'margin-top:8px' }, `${failed.length} não foi(ram) criado(s):`));
      const ul = el('ul', { class: 'cr-errors' });
      failed.forEach(({ v }) => ul.appendChild(el('li', {}, `${v.name} — "${v.title}": ${state.cr.batchRes[v.key]?.msg || 'erro'}`)));
      box.appendChild(ul);
    }
    if (stopped) box.appendChild(el('div', { class: 'small', style: 'margin-top:8px' }, stopped));
    void sender;
    return box;
  }

  async function crReset() {
    if (state.cr.busy) { toast('Espere a validação/publicação em andamento terminar', 'warn'); return; }
    if (!await confirm('Começar de novo', 'Apaga o rascunho atual deste navegador.', 'Apagar rascunho', true)) return;
    if (state.cr.busy) return;
    localStorage.removeItem(CR_DRAFT_KEY);
    state.cr.gen++;
    state.cr.cat = null; state.cr.pictures = []; state.cr.templateTerms = [];
    state.cr.vars = []; state.cr.batchSel = new Map(); state.cr.batchRes = {}; state.cr.netBy = {}; state.cr.pendingSender = null;
    crClearSender();
    ['cr-title', 'cr-price', 'cr-price-premium', 'cr-desc', 'cr-key', 'cr-predict-q', 'cr-warranty-time', 'cr-copy-url'].forEach(id => { if ($(id)) $(id).value = ''; });
    if ($('cr-warranty-type')) $('cr-warranty-type').value = '';
    if ($('cr-fmt-classic')) $('cr-fmt-classic').checked = true;
    if ($('cr-fmt-premium')) $('cr-fmt-premium').checked = false;
    if ($('cr-title-options')) $('cr-title-options').innerHTML = '';
    crSrcNote(null); crRenderVars(); crFormatUI(); crFees(); crWarrantyUI();
    if ($('cr-qty')) $('cr-qty').value = 1;
    document.querySelectorAll('#cr-sender-fields textarea').forEach(t => { t.value = ''; });
    if ($('cr-sender-on')) $('cr-sender-on').checked = false;
    $('cr-cat-info').textContent = ''; $('cr-predict-list').innerHTML = '';
    crResult(null); crRenderPhotos(); crShowForm(false);
  }

  function crAIBody(kind) {
    const d = crCollectDraft();
    const names = Object.fromEntries((state.cr.cat?.attributes || []).map(a => [a.id, a.name]));
    return { kind, name: d.title || ($('cr-predict-q')?.value || ''), category: state.cr.cat?.path || '',
      max_title_length: $('cr-title')?.maxLength || 60,
      attributes: d.attributes.map(a => ({ name: names[a.id] || a.id, value: a.value_name })),
      notes: ($('cr-ai-notes')?.value || '') };
  }

  async function crAIDesc() {
    const ta = $('cr-desc');
    if (ta.value.trim() && !await confirm('Substituir descrição', 'A IA vai escrever uma nova descrição no lugar da atual.', 'Substituir')) return;
    const btn = $('btn-cr-ai-desc'); btn.disabled = true; btn.textContent = '✨ Escrevendo…';
    try {
      const r = await api('/api/create/ai_text', { method: 'POST', body: crAIBody('description') });
      ta.value = r.text || ''; crAutosave();
      toast('Descrição sugerida — revise antes de publicar', 'ok');
    } catch (e) { toast(e.message, 'err', 7000); }
    finally { btn.disabled = false; btn.textContent = '✨ Escrever com IA'; }
  }

  async function crAITitle() {
    const btn = $('btn-cr-ai-title'), label = btn.textContent;
    btn.disabled = true; btn.textContent = '✨ Pensando…';
    const box = $('cr-title-options'); box.innerHTML = '';
    try {
      const r = await api('/api/create/ai_text', { method: 'POST', body: { ...crAIBody('title'), count: 5, avoid: crTitles() } });
      const opts = (r.options || []).filter(o => !crTitles().some(t => crFold(t) === crFold(o)));
      if (!opts.length) { toast('A IA não trouxe nomes novos — tente de novo', 'warn'); return; }
      box.appendChild(el('div', { class: 'muted small' }, 'Sugestões da IA — revise antes de usar (ela pode errar):'));
      opts.forEach(o => {
        const row = el('div', { class: 'cr-sugg' });
        const use = el('button', { class: 'btn ghost sm' }, 'Usar como principal');
        use.addEventListener('click', () => { $('cr-title').value = o; crTitleCount(); row.remove(); crOnEdit(); });
        const add = el('button', { class: 'btn dark sm' }, '+ Variação');
        add.addEventListener('click', () => { if (crAddVar(o)) row.remove(); });
        row.append(el('span', { class: 'cr-sugg-text' }, o), el('span', { class: 'muted small cr-var-count' }, String(o.length)), use, add);
        box.appendChild(row);
      });
    } catch (e) { toast(e.message, 'err', 7000); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  // ════════════ ANÁLISE DE VENDAS (Estatísticas) ════════════
  // Busca os pedidos do período direto do Mercado Livre (via Worker), localiza
  // os compradores e calcula tudo aqui no navegador. Nada disso grava no KV.
  const UF_INFO = {
    AC: ['Acre', 'Norte', 0.83], AL: ['Alagoas', 'Nordeste', 3.13], AP: ['Amapá', 'Norte', 0.73], AM: ['Amazonas', 'Norte', 3.94],
    BA: ['Bahia', 'Nordeste', 14.14], CE: ['Ceará', 'Nordeste', 8.79], DF: ['Distrito Federal', 'Centro-Oeste', 2.82], ES: ['Espírito Santo', 'Sudeste', 3.83],
    GO: ['Goiás', 'Centro-Oeste', 7.06], MA: ['Maranhão', 'Nordeste', 6.78], MT: ['Mato Grosso', 'Centro-Oeste', 3.66], MS: ['Mato Grosso do Sul', 'Centro-Oeste', 2.76],
    MG: ['Minas Gerais', 'Sudeste', 20.54], PA: ['Pará', 'Norte', 8.12], PB: ['Paraíba', 'Nordeste', 3.97], PR: ['Paraná', 'Sul', 11.44],
    PE: ['Pernambuco', 'Nordeste', 9.06], PI: ['Piauí', 'Nordeste', 3.27], RJ: ['Rio de Janeiro', 'Sudeste', 16.05], RN: ['Rio Grande do Norte', 'Nordeste', 3.30],
    RS: ['Rio Grande do Sul', 'Sul', 10.88], RO: ['Rondônia', 'Norte', 1.58], RR: ['Roraima', 'Norte', 0.64], SC: ['Santa Catarina', 'Sul', 7.61],
    SP: ['São Paulo', 'Sudeste', 44.41], SE: ['Sergipe', 'Nordeste', 2.21], TO: ['Tocantins', 'Norte', 1.51],
  }; // população: Censo IBGE 2022, em milhões
  const POP_TOTAL = Object.values(UF_INFO).reduce((s, x) => s + x[2], 0);
  const REGIONS = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];
  // mapa esquemático: cada estado é um quadrado (coluna, linha)
  const TILE_POS = { RR: [1, 0], AP: [2, 0], AM: [1, 1], PA: [2, 1], MA: [3, 1], CE: [4, 1], RN: [5, 1], AC: [0, 2], RO: [1, 2], MT: [2, 2],
    TO: [3, 2], PI: [4, 2], PB: [5, 2], MS: [2, 3], GO: [3, 3], BA: [4, 3], PE: [5, 3], SP: [2, 4], DF: [3, 4], MG: [4, 4], AL: [5, 4],
    PR: [2, 5], RJ: [3, 5], ES: [4, 5], SE: [5, 5], SC: [2, 6], RS: [2, 7] };
  const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brlShort = v => {
    v = Number(v || 0);
    if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
    if (Math.abs(v) >= 1e4) return 'R$ ' + (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
    return 'R$ ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  };
  const pctf = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toLocaleString('pt-BR', { maximumFractionDigits: d }) : '0') + '%';
  const intf = v => Number(v || 0).toLocaleString('pt-BR');
  const brDayOf = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
  // "dd/mm/aaaa hh:mm" in Brasília time, whatever the computer's time zone
  const brDateTime = ms => { const x = new Date(ms - 3 * 3600000).toISOString(); return `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)} ${x.slice(11, 16)}`; };
  const brHourOf = ms => new Date(ms - 3 * 3600000).getUTCHours();
  const brWdOf = ms => new Date(ms - 3 * 3600000).getUTCDay();
  const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const fmtDay = d => d ? d.split('-').reverse().join('/') : '';
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  state.an = { range: '30', uf: '', region: '', cache: {}, cur: null, prev: null, per: null, geo: { b: {}, s: {} }, claims: {}, log: [], busy: false };

  function anStatus(t) { const s = $('an-status'); if (s) s.textContent = t || ''; }

  const AN_MAX_BACK = 365; // a análise cobre até 12 meses para trás
  function anPeriod() {
    const today = brDayOf(Date.now());
    const r = state.an.range;
    let from, to = today;
    if (r === 'custom') { from = $('an-from')?.value || ''; to = $('an-to')?.value || today; }
    else if (r === 'month') from = today.slice(0, 8) + '01';
    else if (r === 'lastmonth') { to = addDays(today.slice(0, 8) + '01', -1); from = to.slice(0, 8) + '01'; }
    else from = addDays(today, -((parseInt(r) || 30) - 1));
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
    if (to > today) to = today;
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    let prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
    if (r === 'month' || r === 'lastmonth') {
      // mês corrente × mesmos dias do mês anterior; mês passado × o mês antes dele
      prevFrom = addDays(from, -1).slice(0, 8) + '01';
      prevTo = r === 'lastmonth' ? addDays(from, -1) : [addDays(prevFrom, days - 1), addDays(from, -1)].sort()[0];
    }
    const minDay = addDays(today, -AN_MAX_BACK);
    return { from, to, days, prevFrom, prevTo, minDay, tooOld: from < minDay, cmpOk: prevFrom >= minDay };
  }

  function splitRange(from, to, maxDays = 31) {
    const out = [];
    for (let a = from; a <= to;) { let b = addDays(a, maxDays - 1); if (b > to) b = to; out.push([a, b]); a = addDays(b, 1); }
    return out;
  }

  // Busca em janelas de até 31 dias; uma janela com mais de 1.000 pedidos é
  // dividida ao meio (buscas muito longas por página podem ser cortadas pelo ML).
  async function anFetchOrders(from, to, label) {
    const out = [];
    const windows = splitRange(from, to);
    while (windows.length) {
      const [a, b] = windows.shift();
      let offset = 0;
      for (let g = 0; g < 80; g++) {
        let r;
        try { r = await api(`/api/analytics/orders?from=${a}&to=${b}&offset=${offset}`); }
        catch (e) {
          if (e.data && Array.isArray(e.data.orders)) out.push(...e.data.orders);
          return { orders: out, partial: e.message };
        }
        if (offset === 0 && r.total > 1000 && a < b) {
          const half = Math.floor((Date.parse(b) - Date.parse(a)) / 86400000 / 2);
          const mid = addDays(a, half);
          windows.unshift([a, mid], [addDays(mid, 1), b]);
          break;
        }
        out.push(...(r.orders || []));
        anStatus(`${label}: ${intf(out.length)} pedido(s)…`);
        if (r.next_offset == null) break;
        offset = r.next_offset;
        if (out.length >= 10000) return { orders: anDedupe(out), partial: 'limite de 10.000 pedidos por análise' };
      }
    }
    return { orders: anDedupe(out), partial: '' };
  }
  // the same order never counts twice (paging can overlap if new orders arrive mid-search)
  function anDedupe(list) {
    const seen = new Set();
    return list.filter(o => { const k = String(o.id); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ── localização: cache no navegador (cidade do cadastro muda pouco) ──
  const GEO_KEY = 'mlas_geo_v1', CLAIM_KEY = 'mlas_claims_v1', AN_LAST_KEY = 'mlas_an_last';
  function geoLoad() {
    try { const g = JSON.parse(localStorage.getItem(GEO_KEY) || '{}') || {}; return { b: g.b || {}, s: g.s || {} }; }
    catch { return { b: {}, s: {} }; }
  }
  function geoSave(g) {
    try {
      const b = Object.entries(g.b);
      if (b.length > 20000) g.b = Object.fromEntries(b.sort((x, y) => y[1][2] - x[1][2]).slice(0, 15000));
      localStorage.setItem(GEO_KEY, JSON.stringify(g));
    } catch { /* armazenamento cheio: segue só em memória */ }
  }
  function geoOf(o, g) {
    const s = o.sh && g.s[o.sh];
    if (s && s[0]) return { s: s[0], c: s[1] || '' };
    const b = g.b[o.b];
    return b ? { s: b[0] || '', c: b[1] || '' } : { s: '', c: '' };
  }
  async function anLocate(orders) {
    const g = geoLoad(); const now = Date.now();
    const fresh = e => e && now - e[2] < 90 * 86400000;
    const okId = x => /^\d{1,20}$/.test(String(x || ''));
    const buyers = [...new Set(orders.map(o => o.b).filter(okId))].filter(id => !fresh(g.b[id]));
    const ships = [...new Set(orders.map(o => o.sh).filter(okId))].filter(id => !g.s[id]).slice(0, 150);
    let i = 0, si = 0, multiget = true;
    for (let guard = 0; guard < 200 && (i < buyers.length || si < ships.length); guard++) {
      const bChunk = buyers.slice(i, i + (multiget ? 400 : 35));
      const sChunk = bChunk.length ? [] : ships.slice(si, si + 10);
      let r;
      try { r = await api('/api/analytics/locate', { method: 'POST', body: { buyers: bChunk, shipments: sChunk, multiget } }); }
      catch (e) { break; }
      const rb = r.buyers || {}, rs = r.shipments || {};
      for (const [id, v] of Object.entries(rb)) g.b[id] = [v.s || '', v.c || '', now];
      for (const [id, v] of Object.entries(rs)) g.s[id] = [v.s || '', v.c || '', now];
      multiget = r.multiget !== false;
      let k = 0; while (k < bChunk.length && bChunk[k] in rb) k++;
      let ks = 0; while (ks < sChunk.length && sChunk[ks] in rs) ks++;
      i += k; si += ks;
      anStatus(`Localizando compradores: ${intf(Math.min(i, buyers.length))} de ${intf(buyers.length)}…`);
      if (r.rate_limited || r.transient) { toast('O Mercado Livre não respondeu a tudo agora — parte das localizações fica para a próxima análise', 'warn', 6000); break; }
      if (!k && !ks) break;
      await new Promise(res => setTimeout(res, 300)); // a breath between calls: the Auto Sender shares the quota
    }
    geoSave(g);
    return g;
  }
  async function anClaims(orders) {
    let c; try { c = JSON.parse(localStorage.getItem(CLAIM_KEY) || '{}') || {}; } catch { c = {}; }
    const ids = [...new Set(orders.flatMap(o => o.md || []))].filter(id => !c[id] || c[id].status !== 'closed').slice(0, 120);
    for (let i = 0; i < ids.length; i += 30) {
      try {
        const r = await api('/api/analytics/claims', { method: 'POST', body: { ids: ids.slice(i, i + 30) } });
        for (const [id, v] of Object.entries(r.claims || {})) if (v) c[id] = v;
        if (r.rate_limited) break;
      } catch { break; }
    }
    try { localStorage.setItem(CLAIM_KEY, JSON.stringify(c)); } catch { /* ignore */ }
    return c;
  }

  // ── classificação e agregação ──
  // "confirmed" is the order's initial status, even before payment (ML docs) —
  // only paid / partially refunded orders count as sales
  const PAID_ST = ['paid', 'partially_refunded'];
  const CANCEL_ST = ['cancelled', 'pending_cancel', 'invalid'];
  function anClassify(o) {
    const pays = o.pay || [];
    const paid = PAID_ST.includes(o.st);
    const wasPaid = pays.some(p => ['approved', 'refunded', 'charged_back', 'partially_refunded', 'in_mediation'].includes(p.s));
    const cancelledAfterPay = CANCEL_ST.includes(o.st) && wasPaid;
    const claim = (o.md || []).length > 0;
    const chargeback = pays.some(p => p.s === 'charged_back');
    const units = (o.it || []).reduce((s, x) => s + (x.q || 1), 0);
    return {
      paid, cancelledAfterPay, unpaid: !paid && !cancelledAfterPay, claim, chargeback, units,
      base: paid || cancelledAfterPay,
      gross: paid ? Number(o.tot) || 0 : 0,
      fees: paid ? (o.it || []).reduce((s, x) => s + (x.f || 0) * (x.q || 1), 0) : 0,
      refunds: paid ? pays.reduce((s, p) => s + (p.r || 0), 0) : 0,
      problem: cancelledAfterPay || claim || chargeback,
    };
  }
  function anCancelReason(o) {
    const cx = o.cx || {};
    const by = { buyer: 'comprador', seller: 'você (vendedor)', mediator: 'Mercado Livre', fraud: 'Mercado Livre (fraude)' }[cx.by] || (cx.by || 'não informado');
    return { by, why: cx.ds || cx.code || 'sem descrição' };
  }
  function anAggregate(orders, g, claims) {
    const A = { orders: 0, base: 0, paid: 0, gross: 0, fees: 0, refunds: 0, units: 0, cancel: 0, unpaid: 0, claims: 0, chargebacks: 0,
      problems: 0, located: 0, multiUnit: 0, buyers: new Map(), cancelBy: {}, cancelWhy: {}, claimWhy: {}, byDay: new Map(),
      byUF: new Map(), byCity: new Map(), byProd: new Map(), heat: Array.from({ length: 7 }, () => new Array(24).fill(0)),
      lt: { gold_special: { n: 0, gross: 0, fees: 0 }, gold_pro: { n: 0, gross: 0, fees: 0 } }, unknownGeo: { base: 0, gross: 0, paid: 0, problems: 0 } };
    const bump = (map, key, init) => { let v = map.get(key); if (!v) { v = init(); map.set(key, v); } return v; };
    const placeInit = () => ({ base: 0, paid: 0, gross: 0, problems: 0, cancel: 0, claims: 0, buyers: new Set() });
    A.byMonth = new Map();
    for (const o of orders) {
      const c = anClassify(o);
      A.orders++;
      // month by month: every order Mercado Livre returned, for checking against its own reports
      const mo = bump(A.byMonth, brDayOf(o.d).slice(0, 7), () => ({ orders: 0, paid: 0, cancel: 0, unpaid: 0, gross: 0, units: 0 }));
      mo.orders++;
      if (c.paid) { mo.paid++; mo.gross += c.gross; mo.units += c.units; }
      else if (c.cancelledAfterPay) mo.cancel++;
      else mo.unpaid++;
      if (c.unpaid) { A.unpaid++; continue; }
      A.base++;
      const geo = g ? geoOf(o, g) : { s: '', c: '' };
      if (c.paid) {
        A.paid++; A.gross += c.gross; A.fees += c.fees; A.refunds += c.refunds; A.units += c.units;
        if (c.units > 1) A.multiUnit++;
        const day = brDayOf(o.d);
        const dd = bump(A.byDay, day, () => ({ gross: 0, n: 0 })); dd.gross += c.gross; dd.n++;
        A.heat[brWdOf(o.d)][brHourOf(o.d)]++;
        const it0 = (o.it || [])[0] || {};
        const lt = A.lt[it0.lt]; if (lt) { lt.n++; lt.gross += c.gross; lt.fees += c.fees; }
      }
      if (c.cancelledAfterPay) {
        A.cancel++;
        const r = anCancelReason(o);
        A.cancelBy[r.by] = (A.cancelBy[r.by] || 0) + 1;
        A.cancelWhy[r.why] = (A.cancelWhy[r.why] || 0) + 1;
      }
      if (c.claim) {
        A.claims++;
        for (const id of o.md) { const cl = claims && claims[id]; const why = cl ? cl.reason : 'motivo não consultado'; A.claimWhy[why] = (A.claimWhy[why] || 0) + 1; }
      }
      if (c.chargeback) A.chargebacks++;
      if (c.problem) A.problems++;
      // comprador
      const bu = bump(A.buyers, o.b || o.n, () => ({ nick: o.n, paid: 0, problems: 0, gross: 0, uf: geo.s }));
      if (c.paid) { bu.paid++; bu.gross += c.gross; }
      if (c.problem) bu.problems++;
      // lugar
      if (geo.s) {
        A.located++;
        for (const [map, key] of [[A.byUF, geo.s], [A.byCity, geo.s + '|' + (geo.c || '?')]]) {
          const p = bump(map, key, placeInit);
          p.base++; if (c.paid) { p.paid++; p.gross += c.gross; }
          if (c.problem) p.problems++; if (c.cancelledAfterPay) p.cancel++; if (c.claim) p.claims++;
          p.buyers.add(o.b);
        }
      } else { A.unknownGeo.base++; A.unknownGeo.gross += c.gross; if (c.paid) A.unknownGeo.paid++; if (c.problem) A.unknownGeo.problems++; }
      // produto
      for (const it of (o.it || []).slice(0, 1)) {
        const p = bump(A.byProd, it.id, () => ({ title: it.t, base: 0, paid: 0, units: 0, gross: 0, fees: 0, problems: 0, premium: 0 }));
        p.base++; if (c.paid) { p.paid++; p.units += c.units; p.gross += c.gross; p.fees += c.fees; if (it.lt === 'gold_pro') p.premium++; }
        if (c.problem) p.problems++;
      }
    }
    A.net = A.gross - A.fees - A.refunds;
    A.ticket = A.paid ? A.gross / A.paid : 0;
    A.rate = x => A.base ? x / A.base : 0;
    A.uniqueBuyers = [...A.buyers.values()].filter(b => b.paid > 0).length;
    A.repeatBuyers = [...A.buyers.values()].filter(b => b.paid > 1).length;
    return A;
  }

  // ── filtros (região / estado / cidade) — re-renderiza sem buscar de novo ──
  function anFilterOrders(orders) {
    const { uf, region } = state.an;
    if (!uf && !region) return orders;
    const g = state.an.geo;
    return orders.filter(o => {
      const s = geoOf(o, g).s;
      if (!s) return false;
      if (uf) return s === uf;
      return UF_INFO[s] && UF_INFO[s][1] === region;
    });
  }

  // ── execução ──
  async function anRun(force) {
    // a click while an analysis runs is not lost: it runs right after, with the latest choice
    if (state.an.busy) { state.an.pending = force || state.an.pending === 'force' ? 'force' : 'normal'; return; }
    const per = anPeriod();
    if (!per || per.from > per.to) { toast('Escolha um período válido', 'warn'); return; }
    if (per.tooOld) { toast(`A análise cobre até 12 meses para trás (a partir de ${fmtDay(per.minDay)})`, 'warn', 6000); return; }
    if (per.days > 366) { toast('Período máximo: 1 ano', 'warn'); return; }
    per.range = state.an.range;
    state.an.busy = true;
    const body = $('an-body'); if (body) body.classList.add('an-loading');
    const btn = $('btn-an-run'); if (btn) btn.disabled = true;
    try {
      const key = `${per.from}|${per.to}`;
      const fresh = c => c && !force && !c.partial && Date.now() - c.at < 30 * 60000;
      let cur = state.an.cache[key];
      if (!fresh(cur)) {
        const r = await anFetchOrders(per.from, per.to, 'Buscando pedidos');
        if (!r.orders.length && r.partial) {
          // nothing came back (e.g. Mercado Livre asked for a pause): keep showing the last good analysis
          toast(r.partial, 'warn', 8000);
          if (state.an.cur) { anRender(); anStatus(`⚠ ${r.partial} — mostrando a análise anterior.`); }
          else anStatus('⚠ ' + r.partial);
          return;
        }
        cur = { orders: r.orders, partial: r.partial, at: Date.now() };
        state.an.cache[key] = cur;
      }
      let prev = null;
      if ($('an-compare')?.checked && per.cmpOk) {
        const pk = `${per.prevFrom}|${per.prevTo}`;
        prev = state.an.cache[pk];
        if (!fresh(prev)) {
          const r = await anFetchOrders(per.prevFrom, per.prevTo, 'Período anterior');
          prev = { orders: r.orders, partial: r.partial, at: Date.now() };
          state.an.cache[pk] = prev;
        }
      }
      if (state.an.pending) return; // another period was chosen meanwhile — it runs next (data stays cached)
      anStatus('Localizando compradores…');
      state.an.geo = await anLocate(cur.orders);
      if (cur.orders.some(o => (o.md || []).length)) { anStatus('Consultando motivos das reclamações…'); state.an.claims = await anClaims(cur.orders); }
      try { state.an.log = await api('/api/orders'); } catch { state.an.log = []; }
      Object.assign(state.an, { cur, prev, per });
      anSaveLast();
      anRender();
    } catch (e) { anStatus('Erro: ' + e.message); toast(e.message, 'err'); }
    finally {
      state.an.busy = false;
      if (body) body.classList.remove('an-loading');
      if (btn) btn.disabled = false;
      if (state.an.pending) { const f = state.an.pending === 'force'; state.an.pending = null; setTimeout(() => anRun(f), 0); }
    }
  }
  // The last analysis is kept in this browser (opens instantly next time). It
  // shares the ~5 MB storage with the draft of "Criar Anúncio" and the location
  // cache, so it stays small: without the previous period if needed, or not at all.
  function anSaveLast() {
    const { cur, prev, per } = state.an;
    const put = obj => {
      try { const t = JSON.stringify(obj); if (t.length > 1200000) return false; localStorage.setItem(AN_LAST_KEY, t); return true; }
      catch { return false; }
    };
    const range = per?.range || state.an.range;
    if (put({ per, range, cur, prev }) || put({ per, range, cur, prev: null })) return;
    try { localStorage.removeItem(AN_LAST_KEY); } catch { /* ignore */ }
  }
  function anRestore() {
    try {
      const d = JSON.parse(localStorage.getItem(AN_LAST_KEY) || 'null');
      if (!d || !d.cur || !d.per) return null;
      state.an.range = d.range || '30';
      if (state.an.range === 'custom') { if ($('an-from')) $('an-from').value = d.per.from; if ($('an-to')) $('an-to').value = d.per.to; }
      Object.assign(state.an, { cur: d.cur, prev: d.prev, per: d.per, geo: geoLoad() });
      try { state.an.claims = JSON.parse(localStorage.getItem(CLAIM_KEY) || '{}') || {}; } catch { /* ignore */ }
      state.an.cache[`${d.per.from}|${d.per.to}`] = d.cur;
      if (d.prev) state.an.cache[`${d.per.prevFrom}|${d.per.prevTo}`] = d.prev;
      return d.cur;
    } catch { return null; }
  }

  function initStats() {
    renderStats();
    anSyncFilterUI();
    if (!state.an.cur) {
      const last = anRestore();
      anSyncFilterUI();
      if (last) anRender();
      if (!last || last.partial || Date.now() - last.at > 30 * 60000) anRun(false);
    } else anRender();
  }

  function anSyncFilterUI() {
    $$('[data-an-range]').forEach(b => b.classList.toggle('active', b.dataset.anRange === state.an.range));
    $('an-custom')?.classList.toggle('hidden', state.an.range !== 'custom');
    const reg = $('an-region'), ufSel = $('an-uf');
    if (reg && !reg.options.length) {
      reg.appendChild(el('option', { value: '' }, 'Todas as regiões'));
      REGIONS.forEach(r => reg.appendChild(el('option', { value: r }, r)));
    }
    if (reg) reg.value = state.an.region;
    if (ufSel) {
      ufSel.innerHTML = '';
      ufSel.appendChild(el('option', { value: '' }, state.an.region ? `Todos (${state.an.region})` : 'Todos os estados'));
      Object.entries(UF_INFO).filter(([, v]) => !state.an.region || v[1] === state.an.region)
        .sort((a, b) => a[1][0].localeCompare(b[1][0], 'pt-BR'))
        .forEach(([k, v]) => ufSel.appendChild(el('option', { value: k }, `${v[0]} (${k})`)));
      ufSel.value = state.an.uf;
    }
  }

  function wireAnalyticsHandlers() {
    $$('[data-an-range]').forEach(b => b.addEventListener('click', () => {
      state.an.range = b.dataset.anRange;
      anSyncFilterUI();
      if (state.an.range === 'custom') {
        // escolhe as duas datas e clica em "Aplicar"
        const today = brDayOf(Date.now());
        for (const id of ['an-from', 'an-to']) { const i = $(id); if (i) { i.max = today; i.min = addDays(today, -AN_MAX_BACK); } }
        if ($('an-from') && !$('an-from').value) $('an-from').value = addDays(today, -29);
        if ($('an-to') && !$('an-to').value) $('an-to').value = today;
        $('an-from')?.focus();
        return;
      }
      anRun(false);
    }));
    bind('btn-an-apply', 'click', () => anRun(false));
    bind('btn-an-run', 'click', () => anRun(true));
    bind('an-compare', 'change', () => anRun(false));
    bind('an-region', 'change', e => { state.an.region = e.target.value; state.an.uf = ''; anSyncFilterUI(); anRender(); });
    bind('an-uf', 'change', e => { state.an.uf = e.target.value; anRender(); });
    bind('an-city-search', 'input', () => { clearTimeout(state.an.searchT); state.an.searchT = setTimeout(() => anRenderGeoTable(state.an.A), 250); });
    bind('btn-an-csv', 'click', anExportCSV);
    bind('btn-an-clear-filter', 'click', () => { state.an.uf = ''; state.an.region = ''; anSyncFilterUI(); anRender(); });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.currentScreen === 'estatisticas' && state.an.A) anRenderRevenue(state.an.A); }, 200); });
  }

  // ── renderização ──
  function anRender() {
    const s = state.an;
    if (!s.cur) return;
    const slice = anFilterOrders(s.cur.orders);
    const A = anAggregate(slice, s.geo, s.claims);
    const filtered = !!(s.uf || s.region);
    // Comparison: never against incomplete data, and when the period ends
    // today, the previous one is cut at the same point of its last day
    // (comparing 15 hours of today with 24 hours of a past day reads as a fall).
    s.cmp = { why: '', cutAt: null };
    let P = null;
    if (s.prev && !filtered) {
      if (s.prev.partial || s.cur.partial) s.cmp.why = 'Sem comparação: um dos períodos veio incompleto (o Mercado Livre pediu uma pausa) — clique em Atualizar.';
      else {
        let prevOrders = s.prev.orders;
        if (s.per.to === brDayOf(s.cur.at)) {
          const elapsed = s.cur.at - Date.parse(`${s.per.from}T00:00:00-03:00`);
          const limit = Date.parse(`${s.per.prevFrom}T00:00:00-03:00`) + elapsed;
          prevOrders = prevOrders.filter(o => o.d <= limit);
          s.cmp.cutAt = s.cur.at;
        }
        P = anAggregate(prevOrders, null, null);
      }
    }
    s.A = A; s.P = P;
    $('an-empty')?.classList.toggle('hidden', A.orders > 0);
    $('an-results')?.classList.toggle('hidden', A.orders === 0);
    const fl = $('an-filter-label');
    if (fl) {
      fl.textContent = filtered ? `Mostrando: ${s.uf ? UF_INFO[s.uf][0] : s.region} · pedidos sem localização ficam de fora` : '';
      $('btn-an-clear-filter')?.classList.toggle('hidden', !filtered);
    }
    anStatus(`${intf(s.cur.orders.length)} pedido(s) de ${fmtDay(s.per.from)} a ${fmtDay(s.per.to)} · dados de ${brDateTime(s.cur.at).slice(0, 5)}, ${brDateTime(s.cur.at).slice(11)}${s.cur.partial ? ' · ⚠ parcial: ' + s.cur.partial : ''}${s.prev?.partial ? ' · ⚠ período anterior incompleto' : ''}`);
    if (!A.orders) return;
    anRenderKPIs(A, P);
    anRenderRevenue(A);
    anRenderMonths(A);
    anRenderMap(A);
    anRenderTopUF(A);
    anRenderGeoTable(A);
    anRenderProblems(A);
    anRenderProducts(A);
    anRenderHeat(A);
    anRenderTips(anTips(A, P));
  }

  function anDelta(cur, prev, upIsGood = true, asPoints = false) {
    if (prev === null || prev === undefined || !Number.isFinite(prev)) return null;
    let d, txt;
    if (asPoints) { d = cur - prev; txt = `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`; }
    else { if (!prev) return null; d = (cur - prev) / prev; txt = `${d >= 0 ? '+' : '−'}${pctf(Math.abs(d), 0)}`; }
    if (Math.abs(d) < 0.0005) return { txt: 'igual', cls: 'flat', icon: '=' };
    const good = (d > 0) === upIsGood;
    return { txt, cls: good ? 'up-good' : 'down-bad', icon: d > 0 ? '▲' : '▼' };
  }

  function anRenderKPIs(A, P) {
    const box = $('an-kpis'); if (!box) return;
    box.innerHTML = '';
    const cancelRate = A.rate(A.cancel), claimRate = A.rate(A.claims);
    const tiles = [
      { label: 'Faturamento bruto', value: brl(A.gross), delta: P && anDelta(A.gross, P.gross), hero: true, sub: `${intf(A.paid)} pedido(s) pago(s)` },
      { label: 'Líquido estimado', value: brl(A.net), delta: P && anDelta(A.net, P.net), sub: `tarifas ${brl(A.fees)}${A.refunds ? ` · estornos ${brl(A.refunds)}` : ''}` },
      { label: 'Ticket médio', value: brl(A.ticket), delta: P && anDelta(A.ticket, P.ticket), sub: `${intf(A.units)} unidade(s)` },
      { label: 'Compradores', value: intf(A.uniqueBuyers), delta: P && anDelta(A.uniqueBuyers, P.uniqueBuyers), sub: A.uniqueBuyers ? `${pctf(A.repeatBuyers / A.uniqueBuyers, 0)} compraram mais de 1 vez` : '' },
      { label: 'Cancelados após pagar', value: `${intf(A.cancel)} · ${pctf(cancelRate)}`, delta: P && anDelta(cancelRate, P.rate(P.cancel), false, true), sub: A.unpaid ? `${intf(A.unpaid)} não pago(s) (Pix/boleto)` : 'sem pedidos não pagos' },
      { label: 'Reclamações', value: `${intf(A.claims)} · ${pctf(claimRate)}`, delta: P && anDelta(claimRate, P.rate(P.claims), false, true), sub: A.chargebacks ? `${intf(A.chargebacks)} contestação(ões) no cartão` : 'das vendas pagas' },
    ];
    for (const t of tiles) {
      const tile = el('div', { class: 'an-kpi' + (t.hero ? ' hero' : '') });
      tile.append(el('div', { class: 'an-kpi-label' }, t.label), el('div', { class: 'an-kpi-value' }, t.value));
      const meta = el('div', { class: 'an-kpi-meta' });
      if (t.delta) meta.appendChild(el('span', { class: `an-delta ${t.delta.cls}` }, `${t.delta.icon} ${t.delta.txt}`));
      if (t.sub) meta.appendChild(el('span', { class: 'muted' }, (t.delta ? ' · ' : '') + t.sub));
      tile.appendChild(meta);
      box.appendChild(tile);
    }
    const note = $('an-kpi-note');
    const per = state.an.per, cmp = state.an.cmp || {};
    const why = state.an.uf || state.an.region ? ' A comparação com o período anterior só aparece sem filtro de região.'
      : cmp.why ? ' ' + cmp.why
      : !per.cmpOk && $('an-compare')?.checked ? ' Sem comparação: o período anterior passaria de 12 meses atrás.' : '';
    const cmpTxt = P ? `▲▼ = comparação com ${fmtDay(per.prevFrom)}–${fmtDay(per.prevTo)}${cmp.cutAt ? `, com o último dia contado só até as ${brDateTime(cmp.cutAt).slice(11)} (o mesmo horário de hoje)` : ''}. ` : '';
    if (note) note.textContent = cmpTxt + 'Líquido = bruto − tarifas do ML − estornos; não inclui impostos.' + why;
  }

  // tooltip único (valor primeiro, rótulo depois), em hover e foco
  function anTipEl() {
    let t = $('an-tip');
    if (!t) { t = el('div', { id: 'an-tip', class: 'an-tip', role: 'tooltip' }); t.hidden = true; document.body.appendChild(t); }
    return t;
  }
  function anTip(node, rowsFn) {
    const place = (x, y) => {
      const t = anTipEl();
      const w = t.offsetWidth || 180, h = t.offsetHeight || 60;
      t.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 14)) + 'px';
      t.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y - h - 10)) + 'px';
    };
    const show = (x, y) => {
      const t = anTipEl(); t.innerHTML = '';
      const rows = rowsFn();
      t.appendChild(el('strong', {}, rows[0]));
      rows.slice(1).forEach(r => t.appendChild(el('div', {}, r)));
      t.hidden = false; place(x, y);
    };
    node.addEventListener('pointerenter', e => show(e.clientX, e.clientY));
    node.addEventListener('pointermove', e => place(e.clientX, e.clientY));
    node.addEventListener('pointerleave', () => { anTipEl().hidden = true; });
    node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
    node.addEventListener('blur', () => { anTipEl().hidden = true; });
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, text) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; };

  function anBuckets(A) {
    const { from, to, days } = state.an.per;
    const mode = days <= 62 ? 'day' : days <= 200 ? 'week' : 'month';
    const keyOf = d => mode === 'day' ? d : mode === 'month' ? d.slice(0, 7) : (() => { const t = Date.parse(d + 'T12:00:00Z'); const wd = (new Date(t).getUTCDay() + 6) % 7; return addDays(d, -wd); })();
    const out = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) { const k = keyOf(d); if (!out.has(k)) out.set(k, { key: k, gross: 0, n: 0 }); }
    for (const [d, v] of A.byDay) { const b = out.get(keyOf(d)); if (b) { b.gross += v.gross; b.n += v.n; } }
    const label = k => mode === 'day' ? fmtDay(k).slice(0, 5) : mode === 'month' ? k.split('-').reverse().join('/') : 'sem. ' + fmtDay(k).slice(0, 5);
    return { mode, rows: [...out.values()].map(r => ({ ...r, label: label(r.key) })) };
  }

  // Month-by-month table for periods longer than ~6 weeks: orders found per
  // month (every status) next to revenue and average ticket — the quickest
  // way to check the numbers against Mercado Livre's own sales report.
  const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function anRenderMonths(A) {
    const box = $('an-months'); if (!box) return;
    box.innerHTML = '';
    const per = state.an.per;
    if (!per || per.days <= 45 || !A.byMonth || !A.byMonth.size) return;
    const months = [];
    for (let m = per.from.slice(0, 7); m <= per.to.slice(0, 7);) {
      months.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
    const tot = { orders: 0, paid: 0, cancel: 0, gross: 0 };
    const rows = months.map(m => {
      const d = A.byMonth.get(m) || { orders: 0, paid: 0, cancel: 0, gross: 0 };
      tot.orders += d.orders; tot.paid += d.paid; tot.cancel += d.cancel; tot.gross += d.gross;
      const [y, mm] = m.split('-');
      const lastDay = new Date(Date.UTC(Number(y), Number(mm), 0)).getUTCDate();
      const inProgress = per.to === brDayOf(state.an.cur?.at || Date.now()); // the last day is still running
      const partial = (m === per.from.slice(0, 7) && per.from.slice(8) !== '01') || (m === per.to.slice(0, 7) && (Number(per.to.slice(8)) < lastDay || inProgress));
      return [`${MONTHS[Number(mm) - 1]}/${y}${partial ? ' (parcial)' : ''}`, intf(d.orders), intf(d.paid), intf(d.cancel), brl(d.gross), d.paid ? brl(d.gross / d.paid) : '—'];
    });
    rows.push(['Total', intf(tot.orders), intf(tot.paid), intf(tot.cancel), brl(tot.gross), tot.paid ? brl(tot.gross / tot.paid) : '—']);
    box.appendChild(el('div', { class: 'an-sub', style: 'margin-top:16px' }, 'Mês a mês'));
    box.appendChild(anTable(['Mês', 'Pedidos encontrados', 'Pagos', 'Cancelados após pagar', 'Faturamento', 'Ticket médio'], rows));
    box.querySelector('tbody tr:last-child')?.classList.add('an-total');
    box.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' },
      'Pedidos encontrados = tudo o que o Mercado Livre devolveu no mês (pagos, cancelados e não pagos). Para conferir, compare com Vendas no Mercado Livre filtrando o mesmo mês. "(parcial)" = o período não cobre o mês inteiro.'));
  }

  function anRenderRevenue(A) {
    const box = $('an-rev-chart'); if (!box) return;
    const { mode, rows } = anBuckets(A);
    const title = $('an-rev-title');
    if (title) title.textContent = { day: 'Faturamento por dia', week: 'Faturamento por semana', month: 'Faturamento por mês' }[mode];
    box.innerHTML = '';
    const W = Math.max(280, box.clientWidth || 640), H = 230, pad = { l: 74, r: 10, t: 22, b: 28 }; // room for "R$ 12,5 mil"
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    const max = niceMax(Math.max(0, ...rows.map(r => r.gross)));
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'an-svg', role: 'img', 'aria-label': (title?.textContent || 'Faturamento') + ' no período' });
    for (const f of [0, 0.5, 1]) {
      const y = pad.t + ch - f * ch;
      svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: f === 0 ? 'an-axis' : 'an-grid' }));
      svg.appendChild(svgEl('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', class: 'an-tick' }, brlShort(max * f)));
    }
    const n = rows.length, band = cw / Math.max(1, n), bw = Math.max(2, Math.min(24, band - 2));
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(cw / 56))));
    let maxI = -1; rows.forEach((r, i) => { if (r.gross > 0 && (maxI < 0 || r.gross > rows[maxI].gross)) maxI = i; });
    rows.forEach((r, i) => {
      const x = pad.l + i * band + (band - bw) / 2;
      const h = r.gross > 0 ? Math.max(2, r.gross / max * ch) : 0;
      const y = pad.t + ch - h;
      if (h > 0) {
        const rr = Math.min(4, bw / 2, h);
        svg.appendChild(svgEl('path', { class: 'an-bar', d: `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + bw - rr}Q${x + bw},${y} ${x + bw},${y + rr}V${y + h}Z` }));
      }
      const hit = svgEl('rect', { x: pad.l + i * band, y: pad.t, width: band, height: ch, class: 'an-hit', tabindex: '0' });
      anTip(hit, () => [brl(r.gross), `${r.label} · ${intf(r.n)} pedido(s)`]);
      svg.appendChild(hit);
      if (i % every === 0) svg.appendChild(svgEl('text', { x: pad.l + i * band + band / 2, y: H - 8, 'text-anchor': 'middle', class: 'an-tick' }, r.label));
      if (i === maxI && n > 1) svg.appendChild(svgEl('text', { x: Math.min(W - pad.r - 4, Math.max(pad.l + 30, x + bw / 2)), y: y - 6, 'text-anchor': 'middle', class: 'an-label' }, brlShort(r.gross)));
    });
    box.appendChild(svg);
  }

  function anBin(v, max) { return v > 0 && max > 0 ? Math.min(5, Math.max(1, Math.ceil(Math.sqrt(v / max) * 5))) : 0; }
  function anLegend(text) {
    const lg = el('div', { class: 'an-legend' });
    lg.appendChild(el('span', { class: 'muted small' }, text[0]));
    for (let b = 1; b <= 5; b++) lg.appendChild(el('span', { class: `an-sw b${b}` }));
    lg.appendChild(el('span', { class: 'muted small' }, text[1]));
    return lg;
  }

  function anRenderMap(A) {
    const box = $('an-map'); if (!box) return;
    box.innerHTML = '';
    const max = Math.max(0, ...[...A.byUF.values()].map(v => v.gross));
    const grid = el('div', { class: 'an-tiles' });
    for (const [uf, [c, r]] of Object.entries(TILE_POS)) {
      const d = A.byUF.get(uf), v = d ? d.gross : 0;
      const t = el('button', { class: `an-tile b${anBin(v, max)}${state.an.uf === uf ? ' sel' : ''}`, style: `grid-column:${c + 1};grid-row:${r + 1}`, 'aria-label': `${UF_INFO[uf][0]}: ${brl(v)}` });
      t.append(el('span', { class: 'an-tile-uf' }, uf), el('span', { class: 'an-tile-v' }, v ? (v / A.gross < 0.005 ? '<1%' : pctf(v / A.gross, 0)) : ''));
      anTip(t, () => d ? [brl(d.gross), `${UF_INFO[uf][0]} · ${pctf(d.gross / (A.gross || 1))} do faturamento`, `${intf(d.paid)} pedido(s) · ${intf(d.buyers.size)} comprador(es)`,
        d.problems ? `${intf(d.problems)} com problema (${pctf(d.problems / d.base)})` : 'nenhum problema'] : ['Sem vendas', UF_INFO[uf][0]]);
      t.addEventListener('click', () => { state.an.region = ''; state.an.uf = state.an.uf === uf ? '' : uf; anSyncFilterUI(); anRender(); });
      grid.appendChild(t);
    }
    box.append(grid, anLegend(['menos', 'mais faturamento']));
    box.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Mapa esquemático: cada quadrado é um estado. Clique para filtrar.'));
  }

  function anRenderTopUF(A) {
    const box = $('an-uf-bars'); if (!box) return;
    box.innerHTML = '';
    const rows = [...A.byUF.entries()].sort((a, b) => b[1].gross - a[1].gross).slice(0, 10);
    if (!rows.length) { box.appendChild(el('div', { class: 'muted small' }, 'Sem localização conhecida para estes pedidos.')); return; }
    const max = rows[0][1].gross || 1;
    box.appendChild(el('div', { class: 'an-sub' }, 'Estados que mais faturam'));
    for (const [uf, d] of rows) {
      const row = el('div', { class: 'an-hbar', tabindex: '0' });
      const track = el('div', { class: 'an-hbar-track' }, el('div', { class: 'an-hbar-fill', style: `width:${Math.max(1, d.gross / max * 100)}%` }));
      row.append(el('span', { class: 'an-hbar-label' }, UF_INFO[uf][0]), track, el('span', { class: 'an-hbar-val' }, `${brlShort(d.gross)} · ${pctf(d.gross / (A.gross || 1), 0)}`));
      anTip(row, () => [brl(d.gross), `${UF_INFO[uf][0]} · ${intf(d.paid)} pedido(s)`, `ticket ${brl(d.paid ? d.gross / d.paid : 0)}`]);
      row.addEventListener('click', () => { state.an.region = ''; state.an.uf = uf; anSyncFilterUI(); anRender(); });
      box.appendChild(row);
    }
    const cov = A.base ? A.located / A.base : 0;
    box.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' },
      `Localização conhecida em ${pctf(cov, 0)} dos pedidos (cidade do cadastro do comprador; em pedidos com envio, o endereço de entrega).`));
  }

  function anTable(head, rows, opts = {}) {
    const t = el('table', { class: 'table an-table' });
    const tr = el('tr'); head.forEach((h, i) => tr.appendChild(el('th', { class: i && opts.num !== false ? 'num' : '' }, h)));
    t.appendChild(el('thead', {}, tr));
    const tb = el('tbody');
    if (!rows.length) { const r = el('tr'); r.appendChild(el('td', { colspan: String(head.length), class: 'muted small' }, opts.empty || 'Nada para mostrar.')); tb.appendChild(r); }
    rows.forEach(cells => { const r = el('tr'); cells.forEach((c, i) => r.appendChild(el('td', { class: i && opts.num !== false ? 'num' : '' }, c))); tb.appendChild(r); });
    t.appendChild(tb);
    return el('div', { class: 'table-wrap' }, t);
  }

  function anRenderGeoTable(A) {
    const box = $('an-geo-table'); if (!box || !A) return;
    box.innerHTML = '';
    const q = fold($('an-city-search')?.value || '');
    const total = A.gross || 1;
    const fmtRow = (name, d, extra) => [name, intf(d.paid), brl(d.gross), pctf(d.gross / total), brl(d.paid ? d.gross / d.paid : 0),
      d.problems ? `${intf(d.problems)} (${pctf(d.problems / d.base)})` : '—', ...extra];
    let head, rows;
    if (q || state.an.uf) {
      head = ['Cidade', 'Pedidos', 'Faturamento', '% do total', 'Ticket médio', 'Problemas'];
      rows = [...A.byCity.entries()]
        .filter(([k]) => { const [uf, city] = k.split('|'); return (!state.an.uf || uf === state.an.uf) && (!q || fold(city).includes(q) || fold(UF_INFO[uf]?.[0]).includes(q) || fold(uf) === q); })
        .sort((a, b) => b[1].gross - a[1].gross).slice(0, 100)
        .map(([k, d]) => { const [uf, city] = k.split('|'); return fmtRow(`${city === '?' ? 'Cidade não informada' : city} — ${uf}`, d, []); });
    } else {
      head = ['Estado', 'Pedidos', 'Faturamento', '% do total', 'Ticket médio', 'Problemas', 'Vendas por milhão de hab.'];
      rows = [...A.byUF.entries()].sort((a, b) => b[1].gross - a[1].gross)
        .map(([uf, d]) => fmtRow(`${UF_INFO[uf][0]} (${uf})`, d, [(d.paid / UF_INFO[uf][2]).toLocaleString('pt-BR', { maximumFractionDigits: 1 })]));
      if (A.unknownGeo.base) rows.push(fmtRow('Sem localização', { ...A.unknownGeo }, ['—']));
    }
    box.appendChild(anTable(head, rows, { empty: 'Nenhuma cidade encontrada.' }));
  }

  function anRenderProblems(A) {
    const box = $('an-problems'); if (!box) return;
    box.innerHTML = '';
    const avg = A.rate(A.problems);
    const ufRows = [...A.byUF.entries()].filter(([, d]) => d.base >= 5 && d.problems > 0)
      .sort((a, b) => b[1].problems / b[1].base - a[1].problems / a[1].base).slice(0, 8)
      .map(([uf, d]) => { const r = d.problems / d.base; return [`${UF_INFO[uf][0]} (${uf})`, intf(d.base), intf(d.cancel), intf(d.claims), pctf(r), avg ? `${(r / avg).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×` : '—']; });
    box.appendChild(el('div', { class: 'an-sub' }, `Taxa geral de problemas: ${pctf(avg)} (${intf(A.problems)} de ${intf(A.base)} vendas pagas)`));
    box.appendChild(anTable(['Estado', 'Vendas', 'Cancelados', 'Reclamações', 'Taxa', 'vs. média'], ufRows, { empty: 'Nenhum estado com 5+ vendas teve problemas. 🎉' }));
    const lists = el('div', { class: 'an-two' });
    const reasonList = (title, obj) => {
      const b = el('div');
      b.appendChild(el('div', { class: 'an-sub' }, title));
      const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (!entries.length) b.appendChild(el('div', { class: 'muted small' }, 'Nenhum.'));
      entries.forEach(([k, v]) => b.appendChild(el('div', { class: 'an-reason' }, el('span', {}, k), el('strong', {}, intf(v)))));
      return b;
    };
    lists.append(reasonList('Motivos das reclamações', A.claimWhy), reasonList('Quem cancelou (após pagar)', A.cancelBy));
    box.appendChild(lists);
    const bad = [...A.buyers.values()].filter(b => b.problems >= 2).sort((a, b) => b.problems - a.problems).slice(0, 10);
    if (bad.length) {
      box.appendChild(el('div', { class: 'an-sub', style: 'margin-top:12px' }, 'Compradores com mais de um problema'));
      box.appendChild(anTable(['Comprador', 'Problemas', 'Compras pagas', 'Estado'], bad.map(b => [b.nick || '—', intf(b.problems), intf(b.paid), b.uf || '—'])));
    }
  }

  function anRenderProducts(A) {
    const box = $('an-products'); if (!box) return;
    box.innerHTML = '';
    const rows = [...A.byProd.entries()].sort((a, b) => b[1].gross - a[1].gross).slice(0, 40).map(([id, d]) => [
      `${d.title || id} (${id})`, intf(d.paid), intf(d.units), brl(d.gross), pctf(d.gross / (A.gross || 1)), brl(d.paid ? d.gross / d.paid : 0),
      d.paid ? pctf(d.premium / d.paid, 0) : '—', d.problems ? `${intf(d.problems)} (${pctf(d.problems / d.base)})` : '—']);
    box.appendChild(anTable(['Anúncio', 'Pedidos', 'Unidades', 'Faturamento', '% do total', 'Ticket', 'Premium', 'Problemas'], rows));
  }

  function anRenderHeat(A) {
    const box = $('an-heat'); if (!box) return;
    box.innerHTML = '';
    const max = Math.max(0, ...A.heat.flat());
    const grid = el('div', { class: 'an-heat' });
    grid.appendChild(el('span'));
    for (let h = 0; h < 24; h++) grid.appendChild(el('span', { class: 'an-heat-h' }, h % 3 === 0 ? String(h).padStart(2, '0') : ''));
    A.heat.forEach((row, wd) => {
      grid.appendChild(el('span', { class: 'an-heat-d' }, WEEKDAYS[wd]));
      row.forEach((v, h) => {
        const c = el('span', { class: `an-cell b${anBin(v, max)}`, tabindex: v ? '0' : '-1' });
        anTip(c, () => [`${intf(v)} pedido(s)`, `${WEEKDAYS[wd]} · ${String(h).padStart(2, '0')}h–${String(h + 1).padStart(2, '0')}h`]);
        grid.appendChild(c);
      });
    });
    box.append(grid, anLegend(['menos', 'mais pedidos']));
  }

  // ── dicas e pontos de atenção (regras sobre os números do período) ──
  function anTips(A, P) {
    const tips = [];
    const add = (level, title, detail) => tips.push({ level, title, detail });
    const s = state.an;
    // tendência
    if (P && P.gross > 0) {
      const ch = (A.gross - P.gross) / P.gross;
      if (ch <= -0.15) {
        const drops = [...P.byProd.entries()].map(([id, p]) => ({ id, t: p.title, d: (A.byProd.get(id)?.gross || 0) - p.gross })).sort((a, b) => a.d - b.d).filter(x => x.d < 0).slice(0, 2);
        add('serious', `Faturamento caiu ${pctf(-ch, 0)} em relação a ${fmtDay(s.per.prevFrom)}–${fmtDay(s.per.prevTo)}`,
          `De ${brl(P.gross)} para ${brl(A.gross)}.${drops.length ? ` Maiores quedas: ${drops.map(x => `${x.t || x.id} (−${brl(-x.d)})`).join('; ')}.` : ''} Confira se esses anúncios estão ativos, com estoque e com preço competitivo.`);
      } else if (ch >= 0.15) add('good', `Faturamento cresceu ${pctf(ch, 0)} em relação a ${fmtDay(s.per.prevFrom)}–${fmtDay(s.per.prevTo)}`, `De ${brl(P.gross)} para ${brl(A.gross)}. Garanta estoque de chaves para acompanhar o ritmo.`);
    }
    // dependência de um produto
    const prods = [...A.byProd.values()].sort((a, b) => b.gross - a.gross);
    if (prods.length && A.gross > 0 && prods[0].gross / A.gross >= 0.6 && A.paid >= 10)
      add('warning', `${pctf(prods[0].gross / A.gross, 0)} do faturamento vem de um só anúncio`, `"${prods[0].title}". Se ele for pausado, ficar sem estoque ou um concorrente baixar o preço, o faturamento cai junto. Vale fortalecer um segundo produto.`);
    // reclamações
    const claimRate = A.rate(A.claims);
    const topReasons = Object.entries(A.claimWhy).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} (${v})`).join(', ');
    const claimProds = [...A.byProd.values()].filter(p => p.problems > 0).sort((a, b) => b.problems - a.problems).slice(0, 2).map(p => p.title).join('; ');
    if (A.claims >= 2 && claimRate >= 0.02) add('critical', `Reclamações em ${pctf(claimRate)} das vendas`, `${intf(A.claims)} no período${topReasons ? ` — motivos: ${topReasons}` : ''}.${claimProds ? ` Anúncios mais afetados: ${claimProds}.` : ''} Reclamações pesam na reputação: revise as instruções de entrega/ativação desses anúncios e responda rápido no chat.`);
    else if (A.claims >= 1) add('warning', `${intf(A.claims)} reclamação(ões) no período (${pctf(claimRate)})`, `${topReasons ? `Motivo: ${topReasons}. ` : ''}Acompanhe na tabela de problemas abaixo.`);
    else if (A.base >= 20) add('good', 'Nenhuma reclamação no período', `${intf(A.base)} vendas pagas sem reclamação.`);
    // cancelamentos
    const sellerCancels = A.cancelBy['você (vendedor)'] || 0;
    if (sellerCancels) add('serious', `${intf(sellerCancels)} venda(s) cancelada(s) por você`, 'Cancelamentos feitos pelo vendedor contam contra a reputação. A causa mais comum é vender sem estoque — mantenha o estoque de chaves acima do aviso de "poucas chaves".');
    const buyerCancels = A.cancelBy['comprador'] || 0;
    if (A.base >= 10 && buyerCancels / A.base >= 0.05) add('warning', `${pctf(buyerCancels / A.base)} dos compradores cancelaram depois de pagar`, 'Pode indicar dúvida sobre o produto ou sensação de demora. Deixe claro no anúncio que a entrega é pelo chat logo após a compra, e confira se a 1ª mensagem está saindo em segundos.');
    if (A.chargebacks) add('critical', `${intf(A.chargebacks)} contestação(ões) de cartão`, 'Compradores contestaram a compra no cartão — é um sinal comum de golpe. Veja os compradores na tabela de problemas e considere bloqueá-los no Mercado Livre.');
    // compradores recorrentes com problema
    const bad = [...A.buyers.values()].filter(b => b.problems >= 2);
    if (bad.length) add('serious', `${intf(bad.length)} comprador(es) com mais de um problema`, `Ex.: ${bad[0].nick} (${bad[0].problems}). O Mercado Livre permite bloquear compradores para impedir novas compras.`);
    // estados acima da média
    const avg = A.rate(A.problems);
    for (const [uf, d] of [...A.byUF.entries()].sort((a, b) => b[1].problems - a[1].problems)) {
      const r = d.base ? d.problems / d.base : 0;
      if (d.base >= 8 && d.problems >= 2 && r >= Math.max(2 * avg, 0.05)) {
        add('warning', `${UF_INFO[uf][0]}: ${pctf(r)} das vendas com problema (média ${pctf(avg)})`, 'Veja se são os mesmos compradores ou o mesmo motivo — padrão repetido numa região pode ser golpe organizado. Os números estão em "Onde há mais problemas".');
        if (tips.length > 10) break;
      }
    }
    // horários
    let best = null;
    for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) {
      const v = A.heat[wd][h] + A.heat[wd][(h + 1) % 24] + A.heat[wd][(h + 2) % 24];
      if (!best || v > best.v) best = { wd, h, v };
    }
    const byWd = A.heat.map(r => r.reduce((a, b) => a + b, 0));
    if (best && A.paid >= 15) {
      const weak = byWd.indexOf(Math.min(...byWd));
      add('info', `Pico de vendas: ${WEEKDAYS[best.wd]}, das ${String(best.h).padStart(2, '0')}h às ${String((best.h + 3) % 24).padStart(2, '0')}h`,
        `${intf(best.v)} pedidos nessa janela. Mantenha estoque de chaves alto e o envio automático ligado nesse horário. Dia mais fraco: ${WEEKDAYS[weak]} (${intf(byWd[weak])} pedidos) — bom momento para manutenção e ajustes de anúncios.`);
    }
    // recompra
    if (A.uniqueBuyers >= 20) {
      const rr = A.repeatBuyers / A.uniqueBuyers;
      if (rr >= 0.1) add('good', `${pctf(rr, 0)} dos compradores voltaram a comprar`, 'Clientes recorrentes: use o Broadcast para avisar sobre renovações ou novas versões (com moderação, para não parecer spam).');
    }
    // várias unidades
    if (A.paid >= 20 && A.multiUnit / A.paid >= 0.08) add('info', `${pctf(A.multiUnit / A.paid, 0)} dos pedidos têm mais de 1 unidade`, 'Considere o recurso "Preços por quantidade" do Mercado Livre (desconto progressivo) ou kits com 2+ licenças.');
    // Clássico x Premium
    const c = A.lt.gold_special, pr = A.lt.gold_pro;
    if (c.n && pr.n) add('info', `Premium: ${pctf(pr.n / (c.n + pr.n), 0)} das vendas`, `Tarifa média: Clássico ${pctf(c.gross ? c.fees / c.gross : 0)} · Premium ${pctf(pr.gross ? pr.fees / pr.gross : 0)}. Compare com o ticket e decida em qual formato vale investir.`);
    else if (c.n >= 20 && !pr.n) add('info', 'Todas as vendas foram em anúncios Clássicos', 'Um anúncio Premium do mesmo produto (parcelado sem juros, mais exposição) pode atrair outro público. Em Criar Anúncio dá para publicar Clássico + Premium de uma vez — acompanhe aqui se compensa a tarifa maior.');
    // regiões sub-representadas
    if (A.located >= 30 && !s.uf && !s.region) {
      for (const reg of ['Nordeste', 'Norte', 'Sul', 'Centro-Oeste']) {
        const popShare = Object.values(UF_INFO).filter(v => v[1] === reg).reduce((t, v) => t + v[2], 0) / POP_TOTAL;
        const sales = [...A.byUF.entries()].filter(([uf]) => UF_INFO[uf][1] === reg).reduce((t, [, d]) => t + d.paid, 0);
        const located = [...A.byUF.values()].reduce((t, d) => t + d.paid, 0) || 1;
        if (popShare >= 0.07 && sales / located <= popShare * 0.5) {
          add('info', `${reg}: ${pctf(popShare, 0)} da população, ${pctf(sales / located, 0)} das suas vendas`, 'É um ponto a analisar, não necessariamente um problema. Em produto físico a causa costuma ser o frete; em digital, alcance dos anúncios e divulgação.');
          break;
        }
      }
    }
    // cobertura da localização
    if (A.base >= 10 && A.located / A.base < 0.6) add('info', `Localização conhecida em só ${pctf(A.located / A.base, 0)} dos pedidos`, 'O Mercado Livre só informa a cidade do cadastro de parte dos compradores; os números por região valem para essa parte.');
    // envio automático no período
    const inRange = (s.log || []).filter(o => o.created_at && brDayOf(Date.parse(o.created_at)) >= s.per.from && brDayOf(Date.parse(o.created_at)) <= s.per.to);
    const noKey = inRange.filter(o => o.skipped === 'no_key').length;
    if (noKey) add('critical', `${intf(noKey)} venda(s) ficaram sem chave no estoque`, 'Esses compradores não receberam a chave automaticamente. Reponha o estoque em Chaves e atenda esses pedidos manualmente.');
    const timed = inRange.filter(o => Number(o.first_msg_ms) > 0);
    if (timed.length >= 5) {
      const avgMs = timed.reduce((t, o) => t + Number(o.first_msg_ms), 0) / timed.length;
      if (avgMs > 10 * 60000) add('warning', `A 1ª mensagem leva em média ${Math.round(avgMs / 60000)} min para sair`, 'Quanto antes o comprador recebe a chave, menor a chance de cancelamento ou reclamação. Verifique em Fila se há pedidos esperando o chat abrir.');
    }
    const order = { critical: 0, serious: 1, warning: 2, info: 3, good: 4 };
    return tips.sort((a, b) => order[a.level] - order[b.level]);
  }

  function anRenderTips(tips) {
    const box = $('an-tips'); if (!box) return;
    box.innerHTML = '';
    if (!tips.length) { box.appendChild(el('div', { class: 'muted small' }, 'Sem pontos de atenção no período — nada fora do normal nos números.')); return; }
    const LBL = { critical: ['⛔', 'Urgente'], serious: ['🔶', 'Importante'], warning: ['⚠', 'Atenção'], info: ['💡', 'Ponto a analisar'], good: ['✅', 'Bom sinal'] };
    for (const t of tips) {
      const [icon, label] = LBL[t.level];
      const item = el('div', { class: `an-tipcard ${t.level}` });
      item.append(el('div', { class: 'an-tip-head' }, el('span', { class: 'an-tip-icon', 'aria-hidden': 'true' }, icon), el('span', { class: 'an-tip-level' }, label), el('strong', {}, t.title)),
        el('div', { class: 'an-tip-detail' }, t.detail));
      box.appendChild(item);
    }
  }

  function anExportCSV() {
    const s = state.an;
    if (!s.cur) { toast('Faça uma análise primeiro', 'warn'); return; }
    const q = csvCell;
    const head = ['pedido', 'data', 'status', 'comprador', 'anuncio', 'titulo', 'tipo', 'unidades', 'total', 'tarifas', 'uf', 'cidade', 'cancelado_apos_pagar', 'reclamacao', 'motivo'];
    const rows = anFilterOrders(s.cur.orders).map(o => {
      const c = anClassify(o), g = geoOf(o, s.geo), it = (o.it || [])[0] || {};
      const motivo = c.claim ? o.md.map(id => s.claims[id]?.reason || '').filter(Boolean).join(' / ') : (c.cancelledAfterPay ? anCancelReason(o).why : '');
      return [o.id, brDateTime(o.d), o.st, o.n, it.id, it.t, it.lt === 'gold_pro' ? 'Premium' : 'Clássico', c.units,
        String(o.tot).replace('.', ','), String(c.fees.toFixed(2)).replace('.', ','), g.s, g.c, c.cancelledAfterPay ? 'sim' : '', c.claim ? 'sim' : '', motivo].map(q).join(';');
    });
    const blob = new Blob(['﻿' + [head.join(';'), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vendas_${s.per.from}_a_${s.per.to}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('CSV baixado', 'ok');
  }

})();
