/**
 * Merchant dashboard (public/dashboard.html)
 * Talks to the /api/merchant/* endpoints in server.js. Every request carries the sign-in token.
 */
(() => {
  'use strict';

  const TOKEN_KEY = 'aurapay_token';
  const $ = (id) => document.getElementById(id);

  const state = {
    token: '',
    merchant: null,
    view: 'overview',
    overview: null,
    orders: { q: '', status: 'ALL', page: 1, pages: 1 },
    customersQuery: '',
    keyVisible: false,
    timers: []
  };
  try { state.token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
  const rupeesShort = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
  const money = (n) => rupees.format(Number(n) || 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function fmtClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  /** "2026-11-25" (a calendar day in the business time zone) -> "25 Nov" */
  function fmtDayKey(key, withWeekday) {
    const d = new Date(`${key}T00:00:00Z`);
    const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    if (withWeekday) opts.weekday = 'short';
    return d.toLocaleDateString('en-IN', opts);
  }
  function fmtDuration(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds} s`;
    const m = Math.floor(seconds / 60);
    return `${m} min ${seconds % 60} s`;
  }

  function toast(message, bad) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' is-bad' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  async function copyText(text, doneMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(doneMessage || 'Copied');
    } catch (e) {
      toast('Could not copy. Select the text and copy it by hand.', true);
    }
  }

  class SignedOutError extends Error {}

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    if (res.status === 401 && state.token) {
      signOut('Your session ended. Please sign in again.');
      throw new SignedOutError();
    }
    return res;
  }

  /** Fetch JSON; returns null (after showing a message) when the request fails. */
  async function getJson(path, options, quiet) {
    try {
      const res = await api(path, options);
      const data = await res.json();
      if (!res.ok || data.success === false) {
        if (!quiet) toast(data.error || 'Something went wrong', true);
        return null;
      }
      return data;
    } catch (e) {
      if (!(e instanceof SignedOutError) && !quiet) toast('Could not reach the server', true);
      return null;
    }
  }

  /** In-page replacement for confirm()/prompt(). Resolves to the typed text ('' if no input) or null if cancelled. */
  function ask({ title, body, confirmLabel = 'Confirm', danger = false, inputLabel = '' }) {
    return new Promise((resolve) => {
      const dialog = $('askDialog');
      $('askTitle').textContent = title;
      $('askBody').textContent = body;
      $('askInputWrap').hidden = !inputLabel;
      $('askInputLabel').textContent = inputLabel;
      $('askInput').value = '';
      const confirmBtn = $('askConfirm');
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

      let answered = false;
      const finish = (value) => {
        if (answered) return;
        answered = true;
        $('askForm').removeEventListener('submit', onSubmit);
        $('askCancel').removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onSubmit = (e) => { e.preventDefault(); finish($('askInput').value.trim()); };
      const onCancel = () => finish(null);
      const onClose = () => finish(null);
      $('askForm').addEventListener('submit', onSubmit);
      $('askCancel').addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      (inputLabel ? $('askInput') : confirmBtn).focus();
    });
  }

  const STATUS_BADGE = {
    PAID: '<span class="badge badge-paid">Paid</span>',
    WAITING: '<span class="badge badge-waiting">Waiting</span>',
    EXPIRED: '<span class="badge badge-expired">Expired</span>'
  };
  const badge = (status) => STATUS_BADGE[status] || esc(status);
  const fact = (label, value) =>
    `<div class="fact"><div class="fact-label">${esc(label)}</div><div class="fact-value">${esc(value == null || value === '' ? '—' : value)}</div></div>`;

  // ------------------------------------------------------------
  // Sign in / out
  // ------------------------------------------------------------
  async function boot() {
    bindEvents();
    if (state.token) {
      const data = await getJson('/api/auth/me', undefined, true);
      if (data && data.merchant) return enterApp(data.merchant);
    }
    showSignIn();
  }

  async function showSignIn(message) {
    stopTimers();
    $('appView').hidden = true;
    $('signinView').hidden = false;
    $('signinError').hidden = !message;
    $('signinError').textContent = message || '';
    $('signinPassword').value = '';
    try {
      const cfg = await (await fetch('/api/auth/config')).json();
      $('signinSetupHint').hidden = cfg.signInReady !== false;
    } catch (e) {}
    $('signinEmail').focus();
  }

  function signOut(message) {
    state.token = '';
    state.merchant = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    showSignIn(message);
  }

  function enterApp(merchant) {
    state.merchant = merchant;
    $('signinView').hidden = true;
    $('appView').hidden = false;
    renderIdentity();
    const fromHash = location.hash.replace('#', '');
    setView(VIEWS[fromHash] ? fromHash : 'overview');
    if (state.view !== 'overview' && state.view !== 'verification') refreshStatus();
    startTimers();
  }

  function renderIdentity() {
    const m = state.merchant;
    $('brandName').textContent = m.businessName || 'Dashboard';
    $('brandMark').textContent = ((m.businessName || 'A').trim()[0] || 'A').toUpperCase();
    $('signedInAs').textContent = `Signed in as ${m.email}`;
    document.title = `${VIEWS[state.view].title} • ${m.businessName || 'Dashboard'}`;
  }

  // ------------------------------------------------------------
  // Views
  // ------------------------------------------------------------
  const VIEWS = {
    overview: { title: 'Overview', sub: 'Money collected, open links and anything that needs you.', load: loadOverview },
    orders: { title: 'Orders', sub: 'Every payment link, with the customer who opened it.', load: loadOrders },
    customers: { title: 'Customers', sub: 'People who entered their details on your checkout page.', load: loadCustomers },
    verification: { title: 'Payment verification', sub: 'How payments are confirmed, and what the mail stream is doing right now.', load: loadVerification },
    developer: { title: 'Developer', sub: 'API key and endpoints for creating payment links from your own site.', load: loadDeveloper },
    settings: { title: 'Settings', sub: 'Business details, the bank alert inbox, sign-in and server info.', load: loadSettings }
  };

  function setView(view, { keepHash = false } = {}) {
    if (!VIEWS[view]) view = 'overview';
    state.view = view;
    document.querySelectorAll('[data-view-panel]').forEach(p => { p.hidden = p.dataset.viewPanel !== view; });
    document.querySelectorAll('.nav-item').forEach(b => {
      const active = b.dataset.view === view;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('pageTitle').textContent = VIEWS[view].title;
    $('pageSub').textContent = VIEWS[view].sub;
    if (state.merchant) document.title = `${VIEWS[view].title} • ${state.merchant.businessName || 'Dashboard'}`;
    if (!keepHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    window.scrollTo(0, 0);
    VIEWS[view].load();
  }

  function startTimers() {
    stopTimers();
    const visible = () => document.visibilityState === 'visible' && !$('appView').hidden;
    // Lists refresh on their own so a payment shows up without reloading
    state.timers.push(setInterval(() => {
      if (!visible()) return;
      if (state.view === 'overview') loadOverview(true);
      if (state.view === 'orders') loadOrders(true);
    }, 15000));
    state.timers.push(setInterval(() => {
      if (visible() && state.view === 'verification') loadVerification(true);
    }, 4000));
    state.timers.push(setInterval(() => {
      if (visible() && state.view !== 'verification' && state.view !== 'overview') refreshStatus();
    }, 30000));
  }
  function stopTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  // ------------------------------------------------------------
  // Verification status (pill in the top bar + dot in the menu)
  // ------------------------------------------------------------
  function describeWatcher(status) {
    switch (status && status.state) {
      case 'connected':
        return { tone: '', short: 'On', title: 'Connected and listening', sub: `Watching ${status.user} for bank credit alerts.` };
      case 'connecting':
        return { tone: 'is-warn', short: 'Connecting…', title: 'Connecting to Gmail…', sub: `Signing in to ${status.user}.` };
      case 'reconnecting':
        return { tone: 'is-warn', short: 'Reconnecting…', title: 'Connection lost, reconnecting', sub: (status.lastError && status.lastError.message) || '' };
      case 'auth_failed':
        return { tone: 'is-error', short: 'Sign-in failed', title: 'Gmail rejected the sign-in', sub: 'Check the Gmail address and App Password in Settings, then press Reconnect.' };
      default:
        return { tone: 'is-off', short: 'Off', title: 'Not set up', sub: 'Add a Gmail address and App Password in Settings to mark orders paid automatically.' };
    }
  }

  function paintStatus(status) {
    const d = describeWatcher(status);
    const pill = $('statusPill');
    pill.classList.remove('is-off', 'is-warn', 'is-error');
    if (d.tone) pill.classList.add(d.tone);
    $('statusPillText').textContent = `Auto-verification: ${d.short}`;
    const dot = $('navVerifyDot');
    dot.className = `nav-dot ${d.tone === '' ? 'is-good' : d.tone === 'is-off' ? '' : d.tone}`;
  }

  async function refreshStatus() {
    const data = await getJson('/api/merchant/imap', undefined, true);
    if (data) paintStatus(data.status);
  }

  function paintWaitingCount(count) {
    const el = $('navWaitingCount');
    el.hidden = !count;
    el.textContent = count || '';
    el.title = count ? `${plural(count, 'order')} waiting for payment` : '';
  }

  // ------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------
  async function loadOverview(quiet) {
    const data = await getJson('/api/merchant/overview', undefined, quiet === true);
    if (!data) return;
    state.overview = data;
    state.merchant = data.merchant;
    renderIdentity();
    paintStatus(data.watcher);
    paintWaitingCount(data.totals.waiting.count);

    const levelLabel = { error: 'Fix', warning: 'Check', info: 'Note' };
    $('attentionList').innerHTML = data.attention.map(a => `
      <div class="attention-item is-${esc(a.level)}">
        <div class="attention-text"><span class="attention-tag">${levelLabel[a.level] || 'Note'}</span><span>${esc(a.text)}</span></div>
        <button type="button" class="btn btn-small" data-go="${esc(a.go)}">Open</button>
      </div>`).join('');

    const t = data.totals;
    const kpi = (label, value, note) =>
      `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-note">${esc(note)}</div></div>`;
    $('kpiGrid').innerHTML = [
      kpi('Collected today', money(t.today.amount), plural(t.today.count, 'payment')),
      kpi('Last 7 days', money(t.last7Days.amount), plural(t.last7Days.count, 'payment')),
      kpi('All time', money(t.allTime.amount), plural(t.allTime.count, 'payment')),
      kpi('Waiting for payment', String(t.waiting.count), t.waiting.count ? `${money(t.waiting.amount)} in open links` : 'No open links'),
      kpi('Paid vs expired', t.successRate == null ? '—' : `${t.successRate}%`, t.successRate == null ? 'No finished orders yet' : `of finished orders were paid (${t.expired.count} expired)`),
      kpi('Time to pay', fmtDuration(t.medianPaySeconds), t.medianPaySeconds == null ? 'Shown once payments are confirmed automatically' : 'Typical time from link opened to confirmed')
    ].join('');

    renderChart(data.days);

    $('latestOrders').innerHTML = data.recentOrders.length === 0
      ? '<li class="empty">No orders yet. Create a payment link to get started.</li>'
      : data.recentOrders.map(o => `
        <li><button type="button" class="order-row" data-open="${esc(o.orderId)}">
          <span class="order-row-main">
            <span class="order-row-name">${esc(o.customerDetailsAt ? o.customerName : (o.note || o.orderId))}</span><br>
            <span class="order-row-meta mono">${esc(o.orderId)}</span>
            <span class="order-row-meta"> · ${esc(fmtDateTime(o.createdAt))}</span>
          </span>
          <span class="order-row-side">
            <span class="order-row-amount">${esc(money(o.amount))}</span><br>
            ${badge(o.displayStatus)}
          </span>
        </button></li>`).join('');
  }

  // One series (money per day), so one color and no legend. Hover shows the exact figures; the table toggle is the accessible view.
  function renderChart(days) {
    const W = 720, H = 240, left = 46, right = 8, top = 12, bottom = 26;
    const plotW = W - left - right, plotH = H - top - bottom;
    const max = Math.max(...days.map(d => d.amount), 0);
    const niceMax = (() => {
      if (max <= 0) return 100;
      const pow = Math.pow(10, Math.floor(Math.log10(max)));
      return [1, 2, 3, 4, 5, 6, 8, 10].map(m => m * pow).find(v => v >= max);
    })();
    const band = plotW / days.length;
    const barW = Math.min(band - 6, 32);
    const y = (v) => top + plotH - (v / niceMax) * plotH;

    const grid = [0, 0.5, 1].map(f => {
      const gy = y(niceMax * f);
      return `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}"/>
        <text class="axis-label" x="${left - 8}" y="${gy + 4}" text-anchor="end">₹${esc(rupeesShort.format(niceMax * f))}</text>`;
    }).join('');

    const cols = days.map((d, i) => {
      const x = left + i * band + (band - barW) / 2;
      const h = d.amount > 0 ? Math.max((d.amount / niceMax) * plotH, 2) : 0;
      const r = Math.min(4, h);
      const by = top + plotH - h;
      const bar = h === 0 ? '' :
        `<path class="bar" d="M${x},${top + plotH} V${by + r} Q${x},${by} ${x + r},${by} H${x + barW - r} Q${x + barW},${by} ${x + barW},${by + r} V${top + plotH} Z"/>`;
      const showLabel = i === days.length - 1 || (days.length - 1 - i) % 2 === 0;
      const label = showLabel ? `<text class="axis-label" x="${left + i * band + band / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtDayKey(d.date))}</text>` : '';
      return `<g class="bar-col" data-i="${i}">
        <rect class="bar-hit" x="${left + i * band}" y="${top}" width="${band}" height="${plotH}"/>${bar}${label}</g>`;
    }).join('');

    $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${cols}</svg>` +
      (max <= 0 ? '<div class="chart-empty">No confirmed payments in the last 14 days.</div>' : '');

    $('chartTableBody').innerHTML = days.slice().reverse().map(d =>
      `<tr><td>${esc(fmtDayKey(d.date, true))}</td><td class="num">${d.count}</td><td class="num">${esc(money(d.amount))}</td></tr>`).join('');

    const tip = $('chartTip');
    const wrap = $('chartWrap');
    const hide = () => {
      tip.hidden = true;
      wrap.querySelectorAll('.bar-col.is-active').forEach(g => g.classList.remove('is-active'));
    };
    wrap.querySelectorAll('.bar-col').forEach(g => {
      const show = () => {
        hide();
        const d = days[Number(g.dataset.i)];
        g.classList.add('is-active');
        tip.innerHTML = `<strong>${esc(money(d.amount))}</strong>${esc(fmtDayKey(d.date, true))} · ${esc(plural(d.count, 'payment'))}`;
        tip.hidden = false;
        const box = wrap.getBoundingClientRect();
        const target = (g.querySelector('.bar') || g.querySelector('.bar-hit')).getBoundingClientRect();
        const anchorTop = g.querySelector('.bar') ? target.top : target.bottom - 4;
        const half = tip.offsetWidth / 2;
        const cx = Math.min(Math.max(target.left + target.width / 2 - box.left, half + 2), box.width - half - 2);
        tip.style.left = `${cx}px`;
        tip.style.top = `${Math.max(anchorTop - box.top - 8, tip.offsetHeight + 2)}px`;
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerdown', show);
      g.addEventListener('pointerleave', hide);
    });
  }

  // ------------------------------------------------------------
  // Orders
  // ------------------------------------------------------------
  async function loadOrders(quiet) {
    const o = state.orders;
    const params = new URLSearchParams({ status: o.status, page: String(o.page), limit: '25' });
    if (o.q) params.set('q', o.q);
    const data = await getJson(`/api/merchant/orders?${params}`, undefined, quiet === true);
    if (!data) return;

    o.page = data.page;
    o.pages = data.pages;
    Object.keys(data.counts).forEach(k => {
      const el = document.querySelector(`[data-count="${k}"]`);
      if (el) el.textContent = data.counts[k];
    });
    if (!o.q) paintWaitingCount(data.counts.WAITING);

    $('ordersBody').innerHTML = data.orders.length === 0
      ? `<tr><td colspan="6" class="empty">${o.q || o.status !== 'ALL' ? 'No orders match this search or filter.' : 'No orders yet. Create a payment link to get started.'}</td></tr>`
      : data.orders.map(row => {
        const hasCustomer = Boolean(row.customerDetailsAt);
        const ref = row.paymentDetails ? (row.paymentDetails.utr || row.paymentDetails.txnId || '—') : '—';
        return `
        <tr data-open="${esc(row.orderId)}" tabindex="0">
          <td><div class="cell-strong mono nowrap">${esc(row.orderId)}</div><div class="cell-sub">${esc(row.note || '')}</div></td>
          <td>${hasCustomer
            ? `<div class="cell-strong">${esc(row.customerName)}</div><div class="cell-sub mono">${esc(row.customerPhone || '')}</div><div class="cell-sub">${esc(row.customerEmail || '')}</div>`
            : '<span class="cell-sub">Details not entered yet</span>'}</td>
          <td class="num cell-strong nowrap">${esc(money(row.amount))}</td>
          <td>${badge(row.displayStatus)}</td>
          <td class="mono">${esc(ref)}</td>
          <td class="nowrap">${esc(fmtDateTime(row.createdAt))}</td>
        </tr>`;
      }).join('');

    const from = data.total === 0 ? 0 : (data.page - 1) * data.limit + 1;
    const to = Math.min(data.page * data.limit, data.total);
    $('ordersPagerInfo').textContent = data.total === 0 ? 'Nothing to show' : `Showing ${from}–${to} of ${data.total}`;
    $('ordersPrev').disabled = data.page <= 1;
    $('ordersNext').disabled = data.page >= data.pages;
  }

  function setOrdersStatus(status) {
    state.orders.status = status;
    state.orders.page = 1;
    document.querySelectorAll('#ordersStatus .seg').forEach(b => b.classList.toggle('active', b.dataset.status === status));
  }

  async function exportCsv() {
    const o = state.orders;
    const params = new URLSearchParams({ format: 'csv', status: o.status });
    if (o.q) params.set('q', o.q);
    try {
      const res = await api(`/api/merchant/orders?${params}`);
      if (!res.ok) return toast('Could not export orders', true);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!(e instanceof SignedOutError)) toast('Could not export orders', true);
    }
  }

  // ------------------------------------------------------------
  // Order drawer
  // ------------------------------------------------------------
  async function openOrder(orderId) {
    const data = await getJson(`/api/merchant/orders/${encodeURIComponent(orderId)}`);
    if (!data) return;
    const o = data.order;
    const p = o.paymentDetails || null;
    const row = (label, value) => value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '';

    $('drawerTitle').textContent = o.orderId;

    const customer = o.customerDetailsAt
      ? `<dl class="kv">
          ${row('Name', esc(o.customerName))}
          ${row('Mobile', o.customerPhone ? `<a href="tel:+91${esc(o.customerPhone)}">${esc(o.customerPhone)}</a>` : '')}
          ${row('Email', o.customerEmail ? `<a href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a>` : '')}
          ${row('Entered', esc(fmtClock(o.customerDetailsAt)))}
        </dl>`
      : '<p class="field-hint">The customer has not entered their details yet.</p>';

    const payment = p
      ? `<dl class="kv">
          ${row('Confirmed', esc(fmtClock(o.verifiedAt)))}
          ${row('Confirmed by', esc(p.source || 'Bank alert email'))}
          ${row('Payer', esc(p.senderName || ''))}
          ${row('Bank reference', p.utr ? `<span class="mono">${esc(p.utr)}</span>` : '')}
          ${row('Transaction ID', p.txnId ? `<span class="mono">${esc(p.txnId)}</span>` : '')}
          ${row('Alert sent by', esc(p.fromAddress || ''))}
        </dl>`
      : `<p class="field-hint">${o.displayStatus === 'EXPIRED'
          ? 'No payment was matched within 30 minutes. If the customer did pay, check your bank statement and mark the order paid.'
          : 'No payment yet. The order is marked paid when a bank alert with this exact amount arrives.'}</p>`;

    $('drawerBody').innerHTML = `
      <div>
        <div class="drawer-amount">${esc(money(o.amount))}</div>
        <div>${badge(o.displayStatus)} <span class="cell-sub">${esc(o.note || '')}</span></div>
      </div>
      <div><div class="drawer-section-title">Customer</div>${customer}</div>
      <div><div class="drawer-section-title">Payment</div>${payment}</div>
      <div>
        <div class="drawer-section-title">Payment link</div>
        <div class="copy-row">
          <input type="text" class="input mono" value="${esc(data.checkoutUrl)}" readonly aria-label="Checkout link">
          <button type="button" class="btn" data-copy="${esc(data.checkoutUrl)}">Copy</button>
          <a class="btn" href="${esc(o.checkoutPath)}" target="_blank" rel="noopener">Open</a>
        </div>
      </div>
      ${o.displayStatus !== 'PAID' && o.dynamicQrDataUrl ? `<div><div class="drawer-section-title">QR code</div><div class="qr-box"><img src="${esc(o.dynamicQrDataUrl)}" alt="UPI QR code for ${esc(money(o.amount))}"></div></div>` : ''}
      <div>
        <div class="drawer-section-title">Details</div>
        <dl class="kv">
          ${row('Created', esc(fmtClock(o.createdAt)))}
          ${o.displayStatus === 'PAID' ? '' : row(o.displayStatus === 'EXPIRED' ? 'Expired' : 'Expires', esc(fmtClock(o.expiresAt)))}
          ${row('Pays to', `<span class="mono">${esc(((o.dynamicUpiUrl || '').match(/pa=([^&]+)/) || [])[1] || '')}</span>`)}
        </dl>
      </div>`;

    $('drawerFoot').innerHTML = o.displayStatus === 'PAID' ? '' : `
      <button type="button" class="btn btn-primary" data-mark-paid="${esc(o.orderId)}" data-amount="${esc(money(o.amount))}">Mark as paid</button>
      <button type="button" class="btn btn-danger-outline" data-delete-order="${esc(o.orderId)}">Delete order</button>`;

    if (!$('orderDrawer').open) $('orderDrawer').showModal();
  }

  async function markPaid(orderId, amountText) {
    const utr = await ask({
      title: `Mark ${orderId} as paid?`,
      body: `Only do this after you see ${amountText} in your bank account. The customer's page will show the success screen.`,
      confirmLabel: 'Mark as paid',
      inputLabel: 'Bank reference / UTR (optional)'
    });
    if (utr === null) return;
    const data = await getJson(`/api/merchant/orders/${encodeURIComponent(orderId)}/mark-paid`, { method: 'POST', body: JSON.stringify({ utr }) });
    if (!data) return;
    toast(`${orderId} marked as paid`);
    openOrder(orderId);
    VIEWS[state.view].load(true);
  }

  async function deleteOrder(orderId) {
    const ok = await ask({
      title: `Delete ${orderId}?`,
      body: 'The payment link stops working and the order, with any customer details on it, is removed for good.',
      confirmLabel: 'Delete order',
      danger: true
    });
    if (ok === null) return;
    const data = await getJson(`/api/merchant/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
    if (!data) return;
    $('orderDrawer').close();
    toast(`${orderId} deleted`);
    VIEWS[state.view].load(true);
  }

  // ------------------------------------------------------------
  // Customers
  // ------------------------------------------------------------
  async function loadCustomers(quiet) {
    const q = state.customersQuery;
    const data = await getJson(`/api/merchant/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`, undefined, quiet === true);
    if (!data) return;
    $('customersCount').textContent = plural(data.total, 'customer');
    $('customersBody').innerHTML = data.customers.length === 0
      ? `<tr><td colspan="7" class="empty">${q ? 'No customers match this search.' : 'No customers yet. They appear here once someone fills in the checkout form.'}</td></tr>`
      : data.customers.map(c => `
        <tr data-open-customer="${esc(c.phone || c.email)}" tabindex="0">
          <td class="cell-strong">${esc(c.name || '—')}</td>
          <td class="mono nowrap">${esc(c.phone || '—')}</td>
          <td>${esc(c.email || '—')}</td>
          <td class="num">${c.orders}</td>
          <td class="num">${c.paidOrders}</td>
          <td class="num cell-strong nowrap">${esc(money(c.totalPaid))}</td>
          <td class="nowrap">${esc(fmtDateTime(c.lastOrderAt))}</td>
        </tr>`).join('');
  }

  // ------------------------------------------------------------
  // Verification
  // ------------------------------------------------------------
  async function loadVerification(quiet) {
    const data = await getJson('/api/merchant/imap', undefined, quiet === true);
    if (data) renderVerification(data.status, data.canHoldImapStream);
  }

  function renderVerification(status, canHold) {
    paintStatus(status);
    const d = describeWatcher(status);
    const banner = $('verifyBanner');
    banner.classList.remove('is-off', 'is-warn', 'is-error');
    if (d.tone) banner.classList.add(d.tone);
    $('verifyTitle').textContent = d.title;

    let sub = d.sub;
    if (status.state !== 'connected' && status.state !== 'reconnecting' && status.lastError) sub += ` Last error: ${status.lastError.message}`;
    if (status.nextRetryAt) sub += ` Next attempt at ${fmtClock(status.nextRetryAt)}.`;
    if (canHold === false) sub += ' This host is serverless and cannot keep a mail connection open. Run the server on an always-on machine for automatic verification.';
    $('verifySub').textContent = sub.trim();

    const st = status.stats || {};
    const senders = (status.allowedSenders || []).length ? status.allowedSenders.join(', ') : 'Any sender (not restricted)';
    $('verifyFacts').innerHTML = [
      fact('Inbox', status.user),
      fact('Connected since', fmtClock(status.connectedAt)),
      fact('Last check', fmtClock(status.lastSyncTime)),
      fact('Emails in inbox', status.mailboxCount),
      fact('Emails read', st.emailsScanned),
      fact('Payment alerts found', st.paymentsDetected),
      fact('Orders marked paid', st.matched),
      fact('Payments with no order', st.unmatched),
      fact('Ignored, untrusted sender', st.ignoredSender),
      fact('Orders waiting now', status.activeQueuedOrders),
      fact('Reconnects', st.reconnects),
      fact('Trusted senders', senders)
    ].join('');

    const payments = status.recentPayments || [];
    $('verifyPaymentsBody').innerHTML = payments.length === 0
      ? '<tr><td colspan="6" class="empty">No payment alerts read yet.</td></tr>'
      : payments.map(p => `
        <tr>
          <td class="nowrap">${esc(fmtClock(p.date))}</td>
          <td class="num cell-strong">${esc(money(p.amount))}</td>
          <td>${esc(p.senderName || '—')}</td>
          <td class="mono">${esc(p.utr || p.txnId || '—')}</td>
          <td>${esc(p.fromAddress || p.source || '—')}</td>
          <td class="mono">${p.claimedByOrder ? esc(p.claimedByOrder) : '<span class="badge badge-waiting">No order</span>'}</td>
        </tr>`).join('');

    const events = status.events || [];
    $('verifyLog').innerHTML = events.length === 0
      ? '<li class="empty">Nothing has happened yet.</li>'
      : events.map(ev => `
        <li><span class="log-tag ${esc(ev.type)}"></span><span class="log-time">${esc(fmtClock(ev.at))}</span><span class="log-msg">${esc(ev.message)}</span></li>`).join('');

    $('btnReconnect').disabled = !status.configured;
  }

  // ------------------------------------------------------------
  // Developer
  // ------------------------------------------------------------
  const ENDPOINTS = [
    ['POST', '/api/v1/checkout/create', 'Create a payment link for an amount', 'Your code, with the API key'],
    ['GET', '/api/v1/checkout/:orderId', 'Order as shown on the checkout page', 'Anyone with the link'],
    ['POST', '/api/v1/checkout/:orderId/customer', 'Save the name, mobile and email the customer typed', 'Anyone with the link'],
    ['GET', '/api/v1/checkout/status/:orderId', 'Has this order been paid yet?', 'Anyone with the link'],
    ['POST', '/api/v1/checkout/verify-utr', 'Match an order to a bank reference the customer typed', 'Anyone with the link'],
    ['GET', '/api/merchant/overview', 'Totals, daily amounts and alerts for this dashboard', 'Signed-in merchant'],
    ['GET', '/api/merchant/orders', 'Orders with search, filter, paging and CSV', 'Signed-in merchant'],
    ['POST', '/api/merchant/orders/:orderId/mark-paid', 'Mark an order paid by hand', 'Signed-in merchant'],
    ['GET', '/api/merchant/customers', 'Customers grouped by mobile number', 'Signed-in merchant'],
    ['GET', '/api/merchant/imap', 'Live state of the mail stream', 'Signed-in merchant'],
    ['PUT', '/api/merchant/settings', 'Change business, inbox and sign-in details', 'Signed-in merchant']
  ];

  function paintApiKey() {
    const key = (state.merchant && state.merchant.apiKey) || '';
    $('apiKeyBox').textContent = state.keyVisible ? key : `${key.slice(0, 10)}${'•'.repeat(18)}${key.slice(-4)}`;
    $('btnKeyShow').textContent = state.keyVisible ? 'Hide' : 'Show';
  }

  async function loadDeveloper() {
    paintApiKey();
    const origin = location.origin;
    $('apiSnippet').textContent =
`curl -X POST ${origin}/api/v1/checkout/create \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "amount": 499, "note": "A3 poster print" }'

# Reply: { "orderId": "PAY-...", "amount": 499, "checkoutUrl": "${origin}/pay/PAY-..." }`;

    $('endpointsBody').innerHTML = ENDPOINTS.map(([method, path, what, who]) =>
      `<tr><td class="method">${esc(method)}</td><td class="mono">${esc(path)}</td><td>${esc(what)}</td><td>${esc(who)}</td></tr>`).join('');

    const data = await getJson('/api/merchant/settings', undefined, true);
    if (!data) return;
    $('devFacts').innerHTML = [
      fact('Server address', origin),
      fact('Checkout without API key', data.system.publicCheckout ? 'Allowed (/pay/new, /test/new)' : 'Off'),
      fact('New merchant sign-ups', data.system.registrationOpen ? 'Open' : 'Off'),
      fact('Order match window', '30 minutes')
    ].join('');
  }

  // ------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------
  async function loadSettings() {
    const data = await getJson('/api/merchant/settings');
    if (data) renderSettings(data);
  }

  function renderSettings(data) {
    const s = data.settings;
    const sys = data.system;
    $('setBusinessName').value = s.businessName || '';
    $('setPayeeName').value = s.payeeName || '';
    $('setUpiId').value = s.upiId || '';
    $('setGmailUser').value = s.gmailUser || '';
    $('setGmailPass').value = '';
    $('setGmailPassHint').textContent = s.hasGmailAppPass
      ? 'An App Password is saved. Leave this empty to keep it, or type a new one to replace it.'
      : 'Not saved yet. Create one at myaccount.google.com/apppasswords (needs 2-Step Verification).';
    $('btnClearGmail').hidden = !s.hasGmailAppPass;
    $('setAllowedSenders').value = (s.allowedSenders || []).join(', ');
    $('setLoginEmail').value = s.loginEmail || '';

    const BANK_FIELD_LABELS = { mc: 'Merchant category', mid: 'Merchant ID', mtid: 'Terminal ID', orgid: 'Bank org ID', mode: 'QR mode', ver: 'Version', qrMedium: 'QR medium', msid: 'Store ID' };
    $('bankQrFacts').hidden = !s.bankQr;
    $('btnBankQrRemove').hidden = !s.bankQr;
    $('btnBankQrUpload').textContent = s.bankQr ? 'Replace bank QR' : 'Upload bank QR';
    $('bankQrStatus').className = `field-hint${s.bankQr ? ' is-ok' : ''}`;
    $('bankQrStatus').textContent = s.bankQr
      ? 'In use. New payment links carry these merchant details.'
      : 'Not set. Payment links use the plain format, which is right for a personal UPI ID.';
    if (s.bankQr) {
      $('bankQrFacts').innerHTML = [fact('Registered name', s.bankQr.payeeName)]
        .concat(Object.entries(s.bankQr.fields).map(([k, v]) => fact(BANK_FIELD_LABELS[k] || k, v))).join('');
    }

    $('passwordEnvNote').hidden = !sys.passwordFromEnv;
    $('passwordFields').hidden = sys.passwordFromEnv;

    $('settingsNotice').hidden = sys.persistent;
    $('settingsNotice').textContent = sys.persistent ? '' :
      'This server has no permanent storage, so changes made here are lost when it restarts. Set the values as environment variables on the host instead, or connect MongoDB.';

    const hours = Math.floor(sys.uptimeSeconds / 3600);
    const mins = Math.floor((sys.uptimeSeconds % 3600) / 60);
    $('systemFacts').innerHTML = [
      fact('Runs on', sys.runtime),
      fact('Data storage', sys.storage),
      fact('Mail stream possible', sys.canHoldImapStream ? 'Yes' : 'No'),
      fact('Started', fmtClock(sys.startedAt)),
      fact('Up for', `${hours} h ${mins} min`),
      fact('Node.js', sys.nodeVersion)
    ].join('');

    $('envBody').innerHTML = (data.environment || []).map(e => `
      <tr><td class="mono nowrap">${esc(e.key)}</td><td>${esc(e.value || '—')}</td><td>${e.editable ? 'On this page' : 'Server .env file or host environment'}</td></tr>`).join('');

    if (data.merchant) {
      state.merchant = data.merchant;
      renderIdentity();
    }
  }

  const SETTING_FIELDS = {
    businessName: 'setBusinessName', payeeName: 'setPayeeName', upiId: 'setUpiId', gmailUser: 'setGmailUser',
    gmailAppPass: 'setGmailPass', allowedSenders: 'setAllowedSenders', loginEmail: 'setLoginEmail'
  };

  // Read the QR the bank issued, show what was found, and use it for payment links once confirmed
  async function uploadBankQr(file) {
    const status = $('bankQrStatus');
    status.className = 'field-hint';
    status.textContent = 'Reading the QR…';
    const form = new FormData();
    form.append('qrImage', file);
    const data = await getJson('/api/merchant/upload-qr?discard=1', { method: 'POST', body: form });
    if (!data) return loadSettings();
    const problem = !data.decoded ? (data.decodeError || 'No QR code was found in that image.')
      : !data.bank ? (data.bankError || 'That is not a UPI payment QR.')
      : Object.keys(data.bank.params).length === 0 ? 'This QR has no merchant details. It looks like a personal UPI QR, which needs nothing extra.'
      : '';
    if (problem) {
      status.className = 'field-hint is-bad';
      status.textContent = problem;
      return;
    }
    const b = data.bank;
    const ok = await ask({
      title: 'Use this bank QR for payment links?',
      body: `${b.payeeName || 'Unnamed payee'} · ${b.upiId} · ${Object.entries(b.params).map(([k, v]) => `${k} ${v}`).join(', ')}. Payments will go to this UPI ID.`,
      confirmLabel: 'Use these details'
    });
    if (ok === null) return loadSettings();
    await saveSettings($('formBusiness'), { bankQr: data.rawQrData }, 'Bank merchant details saved');
  }

  async function saveSettings(form, payload, doneMessage) {
    form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    let data = null;
    try {
      const res = await api('/api/merchant/settings', { method: 'PUT', body: JSON.stringify(payload) });
      data = await res.json();
    } catch (e) {
      if (!(e instanceof SignedOutError)) toast('Could not reach the server', true);
      return null;
    }
    if (data.success) {
      renderSettings(data);
      toast(doneMessage);
      return data;
    }
    const errors = data.errors || {};
    Object.keys(errors).forEach(k => { const el = $(SETTING_FIELDS[k]); if (el) el.classList.add('is-invalid'); });
    toast(Object.values(errors).join('. ') || data.error || 'Could not save', true);
    const first = Object.keys(errors).map(k => $(SETTING_FIELDS[k])).find(Boolean);
    if (first) first.focus();
    return null;
  }

  // ------------------------------------------------------------
  // New payment link
  // ------------------------------------------------------------
  function openLinkModal() {
    $('linkForm').hidden = false;
    $('linkResult').hidden = true;
    $('linkError').hidden = true;
    $('linkForm').reset();
    if (!$('linkModal').open) $('linkModal').showModal();
    $('linkAmount').focus();
  }

  async function createLink(e) {
    e.preventDefault();
    const amount = parseFloat($('linkAmount').value);
    const error = $('linkError');
    error.hidden = true;
    if (!(amount > 0) || amount > 100000) {
      error.textContent = 'Enter an amount between ₹1 and ₹1,00,000.';
      error.hidden = false;
      $('linkAmount').focus();
      return;
    }
    $('linkSubmit').disabled = true;
    const data = await getJson('/api/merchant/create-paywall-link', {
      method: 'POST',
      body: JSON.stringify({ amount, note: $('linkNote').value, customerName: $('linkCustomer').value })
    });
    $('linkSubmit').disabled = false;
    if (!data || !data.order) return;

    const url = `${location.origin}/pay/${data.order.orderId}`;
    $('linkResultAmount').textContent = money(data.order.amount);
    $('linkResultNote').textContent = Math.abs(data.order.amount - amount) >= 0.005
      ? `You asked for ${money(amount)}. Another unpaid link already uses that amount, so a few paise were added to tell the two payments apart.`
      : `Order ${data.order.orderId}`;
    $('linkResultUrl').value = url;
    $('linkResultOpen').href = url;
    $('linkForm').hidden = true;
    $('linkResult').hidden = false;
    $('linkResultCopy').focus();
    if (state.view === 'overview' || state.view === 'orders') VIEWS[state.view].load(true);
  }

  // ------------------------------------------------------------
  // Events
  // ------------------------------------------------------------
  function goTo(target) {
    const [view, arg] = String(target).split(':');
    if (view === 'orders' && arg) {
      setOrdersStatus(arg);
      state.orders.q = '';
      $('ordersSearch').value = '';
    }
    setView(view);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function bindEvents() {
    // Sign in
    $('signinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = $('signinError');
      error.hidden = true;
      $('signinSubmit').disabled = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: $('signinEmail').value.trim(), password: $('signinPassword').value })
        });
        const data = await res.json();
        if (data.success && data.token) {
          state.token = data.token;
          try { localStorage.setItem(TOKEN_KEY, data.token); } catch (err) {}
          $('signinPassword').value = '';
          enterApp(data.merchant);
        } else {
          error.textContent = data.error || 'Could not sign in';
          error.hidden = false;
        }
      } catch (err) {
        error.textContent = 'Could not reach the server';
        error.hidden = false;
      } finally {
        $('signinSubmit').disabled = false;
      }
    });
    $('btnSignOut').addEventListener('click', () => signOut());

    // Navigation
    $('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (btn) setView(btn.dataset.view);
    });
    window.addEventListener('hashchange', () => {
      const view = location.hash.replace('#', '');
      if (state.merchant && VIEWS[view] && view !== state.view) setView(view, { keepHash: true });
    });
    $('statusPill').addEventListener('click', () => setView('verification'));
    $('btnNewLink').addEventListener('click', openLinkModal);

    // Clicks handled once for the whole page: open order, jump to a view, copy, order actions
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) return goTo(go.dataset.go);
      const copy = e.target.closest('[data-copy]');
      if (copy) return copyText(copy.dataset.copy, 'Link copied');
      const mark = e.target.closest('[data-mark-paid]');
      if (mark) return markPaid(mark.dataset.markPaid, mark.dataset.amount);
      const del = e.target.closest('[data-delete-order]');
      if (del) return deleteOrder(del.dataset.deleteOrder);
      const open = e.target.closest('[data-open]');
      if (open) return openOrder(open.dataset.open);
      const customer = e.target.closest('[data-open-customer]');
      if (customer) {
        setOrdersStatus('ALL');
        state.orders.q = customer.dataset.openCustomer;
        $('ordersSearch').value = state.orders.q;
        return setView('orders');
      }
      const closer = e.target.closest('[data-close-modal]');
      if (closer) closer.closest('dialog').close();
    });
    // Table rows are focusable; Enter opens them
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const row = e.target.closest('tr[data-open], tr[data-open-customer]');
      if (row && e.target === row) row.click();
    });

    // Dialogs close when the dark area around them is clicked
    document.querySelectorAll('dialog').forEach(d => {
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    });
    $('drawerClose').addEventListener('click', () => $('orderDrawer').close());

    // Overview
    $('btnChartTable').addEventListener('click', () => {
      const showTable = $('chartTableWrap').hidden;
      $('chartTableWrap').hidden = !showTable;
      $('chartWrap').hidden = showTable;
      $('btnChartTable').textContent = showTable ? 'Show as chart' : 'Show as table';
      $('btnChartTable').setAttribute('aria-pressed', String(showTable));
    });

    // Orders
    $('ordersSearch').addEventListener('input', debounce((e) => {
      state.orders.q = e.target.value.trim();
      state.orders.page = 1;
      loadOrders();
    }, 250));
    $('ordersStatus').addEventListener('click', (e) => {
      const seg = e.target.closest('.seg');
      if (!seg) return;
      setOrdersStatus(seg.dataset.status);
      loadOrders();
    });
    $('ordersPrev').addEventListener('click', () => { state.orders.page--; loadOrders(); });
    $('ordersNext').addEventListener('click', () => { state.orders.page++; loadOrders(); });
    $('btnExportCsv').addEventListener('click', exportCsv);

    // Customers
    $('customersSearch').addEventListener('input', debounce((e) => {
      state.customersQuery = e.target.value.trim();
      loadCustomers();
    }, 250));

    // Verification
    $('btnVerifyRefresh').addEventListener('click', () => loadVerification());
    $('btnReconnect').addEventListener('click', async () => {
      const data = await getJson('/api/merchant/imap/restart', { method: 'POST' });
      if (!data) return;
      renderVerification(data.status, true);
      toast('Reconnecting to Gmail…');
    });

    // Developer
    $('btnKeyShow').addEventListener('click', () => { state.keyVisible = !state.keyVisible; paintApiKey(); });
    $('btnKeyCopy').addEventListener('click', () => copyText(state.merchant.apiKey, 'API key copied'));
    $('btnSnippetCopy').addEventListener('click', () => copyText($('apiSnippet').textContent, 'Example copied'));
    $('btnKeyRegen').addEventListener('click', async () => {
      const ok = await ask({
        title: 'Replace the API key?',
        body: 'The current key stops working immediately. Anything that creates payment links with it must be updated to the new key.',
        confirmLabel: 'Replace key',
        danger: true
      });
      if (ok === null) return;
      const data = await getJson('/api/merchant/regenerate-api-key', { method: 'POST' });
      if (!data) return;
      state.merchant.apiKey = data.apiKey;
      state.keyVisible = true;
      paintApiKey();
      toast('New API key created');
    });

    // Settings
    $('formBusiness').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings(e.target, {
        businessName: $('setBusinessName').value,
        payeeName: $('setPayeeName').value,
        upiId: $('setUpiId').value
      }, 'Business details saved');
    });
    $('btnBankQrUpload').addEventListener('click', () => $('bankQrFile').click());
    $('bankQrFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) uploadBankQr(file);
    });
    $('btnBankQrRemove').addEventListener('click', async () => {
      const ok = await ask({
        title: 'Remove the bank merchant details?',
        body: 'New payment links go back to the plain format. UPI apps may decline payments to a merchant UPI ID again.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (ok === null) return;
      saveSettings($('formBusiness'), { clearBankQr: true }, 'Bank merchant details removed');
    });
    $('formGmail').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = { gmailUser: $('setGmailUser').value, allowedSenders: $('setAllowedSenders').value };
      const pass = $('setGmailPass').value.trim();
      if (pass) payload.gmailAppPass = pass;
      const data = await saveSettings(e.target, payload, 'Inbox details saved');
      if (data && data.gmailRestarted) {
        toast('Connecting to Gmail with the new details…');
        refreshStatus();
      }
    });
    $('btnTestGmail').addEventListener('click', async () => {
      const feedback = $('gmailFeedback');
      feedback.className = 'field-hint';
      feedback.textContent = 'Testing the connection to Gmail…';
      let data = null;
      try {
        const res = await api('/api/merchant/test-email', {
          method: 'POST',
          body: JSON.stringify({ gmailUser: $('setGmailUser').value.trim(), gmailAppPass: $('setGmailPass').value.trim() })
        });
        data = await res.json();
      } catch (e) {
        data = { success: false, error: 'Could not reach the server.' };
      }
      feedback.className = `field-hint ${data.success ? 'is-ok' : 'is-bad'}`;
      feedback.textContent = data.success ? `Connected. ${data.inboxCount} emails in the inbox.` : (data.error || 'Connection failed.');
    });
    $('btnClearGmail').addEventListener('click', async () => {
      const ok = await ask({
        title: 'Remove the Gmail App Password?',
        body: 'The mail stream stops and orders are no longer marked paid automatically until you add one again.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (ok === null) return;
      const data = await saveSettings($('formGmail'), { clearGmailAppPass: true }, 'App Password removed');
      if (data) refreshStatus();
    });
    $('formLogin').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings(e.target, { loginEmail: $('setLoginEmail').value }, 'Sign-in email saved');
    });
    $('formPassword').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = await getJson('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('setCurrentPassword').value, newPassword: $('setNewPassword').value })
      });
      if (!data) return;
      $('setCurrentPassword').value = '';
      $('setNewPassword').value = '';
      toast('Password changed');
    });

    // New link modal
    $('linkForm').addEventListener('submit', createLink);
    $('linkResultCopy').addEventListener('click', () => copyText($('linkResultUrl').value, 'Link copied'));
    $('linkAnother').addEventListener('click', openLinkModal);
  }

  boot();
})();
