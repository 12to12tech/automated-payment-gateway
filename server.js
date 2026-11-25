require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');

const store = require('./services/store');
const auth = require('./services/auth');
const qrHelper = require('./services/qrHelper');
const watcherManager = require('./services/concurrencyWatcher');
const { getIsConnected } = require('./services/mongo');

const app = express();
const PORT = process.env.PORT || 3000;
const STARTED_AT = new Date();
const DEFAULT_MERCHANT_ID = 'merch_default';

const envFlag = (name) => /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());

// Multer Storage Configuration for QR uploads
// On Vercel the project folder is read-only; only the temp folder can be written to
const uploadDir = process.env.VERCEL
  ? path.join(require('os').tmpdir(), 'uploads')
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Middleware
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

const requireAuth = auth.requireAuth(store);

// Initialize Watcher for default merchant on start
const defaultMerchant = store.getMerchantById(DEFAULT_MERCHANT_ID);
if (defaultMerchant && defaultMerchant.gmailUser && defaultMerchant.gmailAppPass) {
  watcherManager.getOrCreate(defaultMerchant);
}

// ---------- Small helpers ----------

const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanText(value, max = 80) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function watcherStatusFor(merchant) {
  const watcher = watcherManager.get(merchant.id);
  if (watcher) return watcher.getStatus();
  return {
    configured: Boolean(merchant.gmailUser && merchant.gmailAppPass),
    state: 'not_configured',
    connected: false,
    user: merchant.gmailUser || null,
    allowedSenders: merchant.allowedSenders || [],
    stats: { emailsScanned: 0, paymentsDetected: 0, matched: 0, unmatched: 0, ignoredSender: 0, reconnects: 0 },
    recentPayments: [],
    events: []
  };
}

/** Pick an amount no other waiting order of this merchant is using (₹1.00, ₹1.01, ₹1.02 ...). */
function allocateAmount(merchantId, numAmount) {
  const pending = store.getPendingOrdersByMerchant(merchantId);
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }
  return finalAmount;
}

/**
 * QR + tap-to-pay link for one order. A merchant UPI ID uses the bank's registered name and
 * merchant fields (saved from the bank's QR); a personal UPI ID uses the plain link.
 */
function paymentRequestFor(merchant, { amount, note, orderId }) {
  const bankParams = merchant.upiParams && Object.keys(merchant.upiParams).length > 0 ? merchant.upiParams : null;
  return qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: (bankParams && merchant.upiPayeeName) || merchant.businessName,
    amount,
    note,
    orderId,
    bankParams
  });
}

async function createOrderFor(merchant, { amount, customerName, customerEmail, note }) {
  const finalAmount = allocateAmount(merchant.id, amount);
  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await paymentRequestFor(merchant, {
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  return store.createOrder({
    orderId,
    merchantId: merchant.id,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Payment #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
}

// An unpaid order can only be matched to a payment for 30 minutes (see store.getPendingOrdersByMerchant).
// After that the dashboard shows it as expired.
const PENDING_WINDOW_MS = 30 * 60 * 1000;
const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';

function displayStatus(order, now = Date.now()) {
  if (order.status === 'PAID' || order.status === 'SUCCESS') return 'PAID';
  return now - new Date(order.createdAt).getTime() > PENDING_WINDOW_MS ? 'EXPIRED' : 'WAITING';
}

/** Order as the dashboard sees it. The QR image is large, so it is only included on request. */
function orderView(order, { withQr = false } = {}) {
  const { dynamicQrDataUrl, ...rest } = order;
  const view = {
    ...rest,
    displayStatus: displayStatus(order),
    checkoutPath: `/pay/${order.orderId}`,
    expiresAt: new Date(new Date(order.createdAt).getTime() + PENDING_WINDOW_MS).toISOString()
  };
  if (withQr) view.dynamicQrDataUrl = dynamicQrDataUrl;
  return view;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Calendar day (YYYY-MM-DD) in the business's time zone, so "today" matches the merchant's clock. */
function dayKey(date) {
  return dayFormatter.format(new Date(date));
}

const roundMoney = (n) => Math.round(n * 100) / 100;
const sumAmounts = (list) => roundMoney(list.reduce((sum, o) => sum + (o.amount || 0), 0));

function matchesSearch(order, q) {
  if (!q) return true;
  const hay = [
    order.orderId, order.customerName, order.customerPhone, order.customerEmail, order.note,
    order.paymentDetails && order.paymentDetails.utr, order.paymentDetails && order.paymentDetails.txnId,
    Number(order.amount || 0).toFixed(2)
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function parseAmount(raw, fallback) {
  const numAmount = parseFloat(raw == null || raw === '' ? fallback : raw);
  if (isNaN(numAmount) || numAmount <= 0 || numAmount > 100000) return null;
  return Math.round(numAmount * 100) / 100;
}

// ==============================================================
// 1. AUTHENTICATION ENDPOINTS
// ==============================================================

// Register new merchant (off unless ALLOW_REGISTRATION=true)
app.post('/api/auth/register', (req, res) => {
  if (!envFlag('ALLOW_REGISTRATION')) {
    return res.status(403).json({ error: 'New account sign-up is turned off on this server.' });
  }

  const { name, email, password, businessName } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (!EMAIL_PATTERN.test(String(email))) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = store.getMerchantByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  const merchant = store.createMerchant({
    name: cleanText(name),
    email: String(email),
    password: String(password),
    businessName: cleanText(businessName)
  });

  res.json({
    success: true,
    token: auth.createToken(merchant.id),
    merchant: store.publicMerchant(merchant)
  });
});

// Login merchant
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const throttleKey = `${req.ip}|${String(email).toLowerCase().trim()}`;
  if (auth.loginBlocked(throttleKey)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 10 minutes.' });
  }

  const merchant = store.getMerchantByEmail(String(email));
  if (!merchant || !store.checkPassword(merchant, String(password))) {
    auth.recordLoginFailure(throttleKey);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  auth.clearLoginFailures(throttleKey);

  // Ensure watcher is active if onboarded
  if (merchant.isOnboarded && merchant.gmailUser && merchant.gmailAppPass) {
    watcherManager.getOrCreate(merchant);
  }

  res.json({
    success: true,
    token: auth.createToken(merchant.id),
    merchant: store.publicMerchant(merchant)
  });
});

// Get current merchant profile
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, merchant: store.publicMerchant(req.merchant) });
});

// Public facts the sign-in page needs (no secrets)
app.get('/api/auth/config', (req, res) => {
  const admin = store.getMerchantById(DEFAULT_MERCHANT_ID);
  res.json({
    registrationOpen: envFlag('ALLOW_REGISTRATION'),
    signInReady: Boolean(process.env.ADMIN_PASSWORD || (admin && admin.password))
  });
});

// Change sign-in password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (store.passwordIsFromEnv(req.merchant)) {
    return res.status(400).json({ error: 'The password is set by ADMIN_PASSWORD in the server environment. Change it there.' });
  }
  if (!store.checkPassword(req.merchant, String(currentPassword || ''))) {
    return res.status(400).json({ error: 'Current password is not correct' });
  }
  if (String(newPassword || '').length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  store.setPassword(req.merchant.id, String(newPassword));
  res.json({ success: true });
});

// ==============================================================
// 2. ONBOARDING WIZARD ENDPOINTS
// ==============================================================

// Upload and Auto-Decode FamPay / UPI QR Image
app.post('/api/merchant/upload-qr', requireAuth, upload.single('qrImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const filePath = req.file.path;
  const webPath = `/uploads/${path.basename(filePath)}`;

  // Automatically decode QR code to extract UPI ID
  const decoded = await qrHelper.decodeQrImage(filePath);

  // The dashboard only needs what the QR says, so the photo itself is not kept
  if (req.query.discard === '1') fs.unlink(filePath, () => {});

  res.json({
    success: true,
    qrImagePath: webPath,
    decoded: Boolean(decoded.success),
    decodeError: decoded.success ? null : decoded.error,
    detectedUpiId: decoded.upiId || req.merchant.upiId,
    detectedPayeeName: decoded.payeeName || req.merchant.businessName,
    rawQrData: decoded.raw || '',
    // Merchant fields found in a bank-issued QR (null for a personal QR)
    bank: decoded.bank || null,
    bankError: decoded.bankError || null
  });
});

// Test Gmail IMAP Connection Live.
// Leave gmailAppPass empty to test with the App Password already saved.
app.post('/api/merchant/test-email', requireAuth, async (req, res) => {
  const body = req.body || {};
  const gmailUser = cleanText(body.gmailUser || req.merchant.gmailUser, 120);
  const gmailAppPass = String(body.gmailAppPass || req.merchant.gmailAppPass || '').replace(/\s+/g, '');
  if (!gmailUser || !gmailAppPass) {
    return res.status(400).json({ error: 'Gmail address and App Password required' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPass },
    logger: false
  });
  client.on('error', () => {});

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    await client.logout();

    res.json({
      success: true,
      message: 'Connected successfully to Gmail IMAP!',
      inboxCount: total
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err && err.authenticationFailed
        ? 'Gmail rejected the sign-in. Make sure 2-Step Verification is on and use a 16-character App Password.'
        : `Could not reach Gmail: ${(err && (err.responseText || err.message)) || 'unknown error'}`
    });
  }
});

// Complete Onboarding
app.post('/api/merchant/complete-onboarding', requireAuth, async (req, res) => {
  const merchant = req.merchant;
  const { businessName, upiId, qrImagePath, gmailUser, gmailAppPass } = req.body || {};

  if (upiId && !UPI_ID_PATTERN.test(String(upiId).trim())) {
    return res.status(400).json({ error: 'Enter a valid UPI ID, for example name@bank' });
  }

  const updated = store.updateMerchant(merchant.id, {
    businessName: cleanText(businessName) || merchant.businessName,
    upiId: upiId ? String(upiId).trim() : merchant.upiId,
    qrImagePath: qrImagePath || merchant.qrImagePath,
    gmailUser: cleanText(gmailUser, 120) || merchant.gmailUser,
    gmailAppPass: gmailAppPass ? String(gmailAppPass).replace(/\s+/g, '') : merchant.gmailAppPass,
    isOnboarded: true
  });

  // Start or update active watcher
  watcherManager.restart(updated);

  res.json({
    success: true,
    merchant: store.publicMerchant(updated)
  });
});

// ==============================================================
// 3. MERCHANT DASHBOARD ENDPOINTS
// ==============================================================

// Everything the Overview screen shows, computed from the real orders
app.get('/api/merchant/overview', requireAuth, (req, res) => {
  const merchant = req.merchant;
  const now = Date.now();
  const orders = store.getOrdersByMerchant(merchant.id);
  const paid = orders.filter(o => displayStatus(o, now) === 'PAID');
  const waiting = orders.filter(o => displayStatus(o, now) === 'WAITING');
  const expired = orders.filter(o => displayStatus(o, now) === 'EXPIRED');
  const paidAt = (o) => o.verifiedAt || o.createdAt;

  // Money collected per day for the last 14 days
  const days = [];
  const byDay = new Map();
  for (let i = 13; i >= 0; i--) {
    const entry = { date: dayKey(now - i * 24 * 60 * 60 * 1000), amount: 0, count: 0 };
    days.push(entry);
    byDay.set(entry.date, entry);
  }
  paid.forEach(o => {
    const entry = byDay.get(dayKey(paidAt(o)));
    if (entry) {
      entry.amount = roundMoney(entry.amount + (o.amount || 0));
      entry.count++;
    }
  });
  const today = days[days.length - 1];
  const last7 = days.slice(-7);

  // How long customers take from opening the link to the payment being confirmed (automatic confirmations only)
  const payTimes = paid
    .filter(o => o.verifiedAt && !(o.paymentDetails && /manual/i.test(o.paymentDetails.source || '')))
    .map(o => (new Date(o.verifiedAt).getTime() - new Date(o.createdAt).getTime()) / 1000)
    .filter(sec => sec >= 0)
    .sort((a, b) => a - b);
  const medianPaySeconds = payTimes.length ? Math.round(payTimes[Math.floor(payTimes.length / 2)]) : null;

  const finished = paid.length + expired.length;
  const watcherStatus = watcherStatusFor(merchant);

  // Things the merchant should act on
  const attention = [];
  if (process.env.VERCEL) {
    attention.push({ level: 'warning', text: 'This host cannot keep the mail stream open, so orders are not marked paid automatically here.', go: 'verification' });
  } else if (watcherStatus.state === 'not_configured') {
    attention.push({ level: 'warning', text: 'Automatic payment checking is off. Add the Gmail inbox that receives your bank alerts.', go: 'settings' });
  } else if (watcherStatus.state === 'auth_failed') {
    attention.push({ level: 'error', text: 'Gmail rejected the sign-in, so payments are not being checked.', go: 'verification' });
  } else if (watcherStatus.state !== 'connected') {
    attention.push({ level: 'warning', text: 'The mail stream is reconnecting. Payments made right now may be confirmed late.', go: 'verification' });
  }
  if (watcherStatus.configured && (merchant.allowedSenders || []).length === 0) {
    attention.push({ level: 'warning', text: 'Any email that looks like a credit alert is trusted. Add your bank as a trusted sender.', go: 'settings' });
  }
  if (!store.isPersistent()) {
    attention.push({ level: 'warning', text: 'This server has no permanent storage. Orders and settings reset when it restarts.', go: 'settings' });
  }
  const expiredWithCustomer = expired.filter(o => o.customerDetailsAt).length;
  if (expiredWithCustomer > 0) {
    attention.push({ level: 'info', text: `${expiredWithCustomer} order${expiredWithCustomer === 1 ? '' : 's'} expired unpaid after the customer entered details. Check your bank statement in case one was paid.`, go: 'orders:EXPIRED' });
  }

  res.json({
    success: true,
    merchant: store.publicMerchant(merchant),
    timezone: BUSINESS_TZ,
    totals: {
      today: { amount: today.amount, count: today.count },
      last7Days: { amount: sumAmounts(last7.map(d => ({ amount: d.amount }))), count: last7.reduce((n, d) => n + d.count, 0) },
      allTime: { amount: sumAmounts(paid), count: paid.length },
      waiting: { amount: sumAmounts(waiting), count: waiting.length },
      expired: { count: expired.length },
      orders: orders.length,
      withCustomerDetails: orders.filter(o => o.customerDetailsAt).length,
      // Of the orders that are finished (paid or expired), how many were paid
      successRate: finished > 0 ? Math.round((paid.length / finished) * 100) : null,
      medianPaySeconds
    },
    days,
    attention,
    watcher: {
      state: watcherStatus.state,
      connected: watcherStatus.connected,
      user: watcherStatus.user,
      lastSyncTime: watcherStatus.lastSyncTime || null
    },
    recentOrders: orders.slice(0, 8).map(o => orderView(o))
  });
});

// Orders with search, status filter and paging; ?format=csv downloads the filtered list
app.get('/api/merchant/orders', requireAuth, (req, res) => {
  const now = Date.now();
  const q = cleanText(req.query.q, 80).toLowerCase();
  const status = String(req.query.status || 'ALL').toUpperCase();
  const searched = store.getOrdersByMerchant(req.merchant.id).filter(o => matchesSearch(o, q));

  const counts = { ALL: searched.length, PAID: 0, WAITING: 0, EXPIRED: 0 };
  searched.forEach(o => { counts[displayStatus(o, now)]++; });
  const filtered = status === 'ALL' ? searched : searched.filter(o => displayStatus(o, now) === status);

  if (req.query.format === 'csv') {
    const cell = (v) => {
      let text = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(text)) text = `'${text}`; // stop spreadsheet apps running it as a formula
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['Order ID', 'Status', 'Amount', 'Customer name', 'Mobile', 'Email', 'Note', 'UTR / Ref', 'Confirmed by', 'Created at', 'Paid at'];
    const rows = filtered.map(o => [
      o.orderId, displayStatus(o, now), Number(o.amount || 0).toFixed(2), o.customerName, o.customerPhone, o.customerEmail, o.note,
      o.paymentDetails ? (o.paymentDetails.utr || o.paymentDetails.txnId) : '',
      o.paymentDetails ? (o.paymentDetails.source || '') : '', o.createdAt, o.verifiedAt
    ].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    return res.send('﻿' + [header.map(cell).join(','), ...rows].join('\r\n'));
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const pages = Math.max(Math.ceil(filtered.length / limit), 1);
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);

  res.json({
    success: true,
    counts,
    page,
    pages,
    limit,
    total: filtered.length,
    orders: filtered.slice((page - 1) * limit, page * limit).map(o => orderView(o))
  });
});

// One order with everything: customer, payment, QR and checkout link
app.get('/api/merchant/orders/:orderId', requireAuth, (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order || order.merchantId !== req.merchant.id) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json({
    success: true,
    order: orderView(order, { withQr: true }),
    checkoutUrl: `${req.protocol}://${req.get('host')}/pay/${order.orderId}`
  });
});

// Remove an unpaid order (test links, mistakes). Paid orders are kept as the payment record.
app.delete('/api/merchant/orders/:orderId', requireAuth, (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order || order.merchantId !== req.merchant.id) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (displayStatus(order) === 'PAID') {
    return res.status(409).json({ error: 'Paid orders cannot be deleted' });
  }
  store.deleteOrder(order.orderId);
  res.json({ success: true });
});

// Customers, built from the details people typed on the checkout page (grouped by mobile number)
app.get('/api/merchant/customers', requireAuth, (req, res) => {
  const q = cleanText(req.query.q, 80).toLowerCase();
  const groups = new Map();

  store.getOrdersByMerchant(req.merchant.id)
    .filter(o => o.customerDetailsAt && (o.customerPhone || o.customerEmail))
    .forEach(o => {
      const key = o.customerPhone || o.customerEmail;
      if (!groups.has(key)) {
        // Orders arrive newest first, so the first one seen carries the latest name / email
        groups.set(key, {
          key, name: o.customerName, phone: o.customerPhone || '', email: o.customerEmail || '',
          orders: 0, paidOrders: 0, totalPaid: 0, lastOrderAt: o.createdAt, lastOrderId: o.orderId
        });
      }
      const c = groups.get(key);
      c.orders++;
      if (displayStatus(o) === 'PAID') {
        c.paidOrders++;
        c.totalPaid = roundMoney(c.totalPaid + (o.amount || 0));
      }
    });

  const customers = [...groups.values()]
    .filter(c => !q || [c.name, c.phone, c.email].join(' ').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt));

  res.json({ success: true, total: customers.length, customers: customers.slice(0, 500) });
});

// Mark an order as paid by hand (after checking the bank statement)
app.post('/api/merchant/orders/:orderId/mark-paid', requireAuth, (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order || order.merchantId !== req.merchant.id) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (order.status === 'PAID') {
    return res.status(409).json({ error: 'This order is already marked paid' });
  }

  const utr = cleanText((req.body || {}).utr, 30);
  const payment = {
    amount: order.amount,
    senderName: order.customerName || 'UPI Customer',
    utr: utr || 'MANUAL',
    txnId: utr ? `TXN-${utr}` : 'MANUAL',
    date: new Date(),
    source: 'Marked paid manually'
  };
  const updated = store.updateOrder(order.orderId, {
    status: 'PAID',
    verifiedAt: new Date().toISOString(),
    paymentDetails: payment
  });

  // Tell the customer's open checkout page straight away
  const watcher = watcherManager.get(req.merchant.id);
  if (watcher) {
    watcher.logEvent('success', `Order ${order.orderId} marked paid by hand (₹${order.amount})`);
    watcher.notifyOrder(order.orderId, { type: 'PAYMENT_SUCCESS', order: updated, payment });
  }

  res.json({ success: true, order: updated });
});

// Create Hosted Paywall Link
app.post('/api/merchant/create-paywall-link', requireAuth, async (req, res) => {
  const { amount, customerName, customerEmail, note } = req.body || {};

  const numAmount = parseAmount(amount, 1.00);
  if (numAmount === null) {
    return res.status(400).json({ error: 'Valid payment amount required' });
  }

  const order = await createOrderFor(req.merchant, {
    amount: numAmount,
    customerName: cleanText(customerName),
    customerEmail: cleanText(customerEmail, 120),
    note: cleanText(note, 80)
  });

  res.json({
    success: true,
    order,
    paywallUrl: `/pay/${order.orderId}`
  });
});

// Regenerate API Key
app.post('/api/merchant/regenerate-api-key', requireAuth, (req, res) => {
  const newKey = `aura_live_${crypto.randomBytes(16).toString('hex')}`;
  const updated = store.updateMerchant(req.merchant.id, { apiKey: newKey });
  res.json({ success: true, apiKey: updated.apiKey });
});

// SSE Stream for Merchant Dashboard
app.get('/api/merchant/events', requireAuth, (req, res) => {
  // No Gmail watcher configured: nothing will ever be sent, so don't hold the connection open
  const watcher = watcherManager.getOrCreate(req.merchant);
  if (!watcher) return res.status(204).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  watcher.subscribeMerchant(res);
});

// ==============================================================
// 4. SETTINGS & IMAP STREAM STATUS
// ==============================================================

function settingsPayload(merchant) {
  const onVercel = Boolean(process.env.VERCEL);
  return {
    settings: {
      businessName: merchant.businessName,
      payeeName: merchant.name,
      upiId: merchant.upiId,
      loginEmail: merchant.email,
      gmailUser: merchant.gmailUser || '',
      hasGmailAppPass: Boolean(merchant.gmailAppPass),
      allowedSenders: merchant.allowedSenders || [],
      apiKey: merchant.apiKey,
      // Merchant fields copied from the bank's QR; null when payment links use the plain personal format
      bankQr: merchant.upiParams && Object.keys(merchant.upiParams).length > 0
        ? { payeeName: merchant.upiPayeeName || '', fields: merchant.upiParams }
        : null
    },
    system: {
      runtime: onVercel ? 'Vercel (serverless)' : 'Always-on Node server',
      canHoldImapStream: !onVercel,
      storage: store.storageLabel(),
      persistent: store.isPersistent(),
      mongoConnected: getIsConnected(),
      nodeVersion: process.version,
      port: onVercel ? null : Number(PORT),
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      publicCheckout: envFlag('PUBLIC_CHECKOUT'),
      registrationOpen: envFlag('ALLOW_REGISTRATION'),
      passwordFromEnv: store.passwordIsFromEnv(merchant),
      sessionSecretFromEnv: Boolean(process.env.SESSION_SECRET)
    },
    // Where each value currently comes from. Secrets are never sent, only whether they are set.
    environment: [
      { key: 'UPI_ID', value: merchant.upiId, editable: true },
      { key: 'UPI_BANK_QR', value: merchant.upiParams && Object.keys(merchant.upiParams).length > 0 ? `Merchant details in use (${Object.keys(merchant.upiParams).join(', ')})` : 'Not set (plain personal links)', editable: true },
      { key: 'BUSINESS_NAME', value: merchant.businessName, editable: true },
      { key: 'PAYEE_NAME', value: merchant.name, editable: true },
      { key: 'GMAIL_USER', value: merchant.gmailUser || '', editable: true },
      { key: 'GMAIL_APP_PASS', value: merchant.gmailAppPass ? 'Saved (hidden)' : 'Not set', secret: true, editable: true },
      { key: 'ADMIN_EMAIL', value: merchant.email, editable: true },
      { key: 'ADMIN_PASSWORD', value: process.env.ADMIN_PASSWORD ? 'Set in server environment (hidden)' : (merchant.password ? 'Saved (hidden)' : 'Not set'), secret: true, editable: !store.passwordIsFromEnv(merchant) },
      { key: 'SESSION_SECRET', value: process.env.SESSION_SECRET ? 'Set in server environment (hidden)' : 'Generated automatically (hidden)', secret: true, editable: false },
      { key: 'MONGODB_URI', value: process.env.MONGODB_URI ? (getIsConnected() ? 'Set, connected' : 'Set, not connected') : 'Not set', secret: true, editable: false },
      { key: 'PUBLIC_CHECKOUT', value: envFlag('PUBLIC_CHECKOUT') ? 'true' : 'false', editable: false },
      { key: 'ALLOW_REGISTRATION', value: envFlag('ALLOW_REGISTRATION') ? 'true' : 'false', editable: false },
      { key: 'PORT', value: onVercel ? 'Managed by Vercel' : String(PORT), editable: false }
    ]
  };
}

app.get('/api/merchant/settings', requireAuth, (req, res) => {
  res.json({ success: true, ...settingsPayload(req.merchant) });
});

app.put('/api/merchant/settings', requireAuth, (req, res) => {
  const merchant = req.merchant;
  const body = req.body || {};
  const updates = {};
  const errors = {};

  if (body.businessName !== undefined) {
    const v = cleanText(body.businessName);
    if (v.length < 2) errors.businessName = 'Enter a business name'; else updates.businessName = v;
  }
  if (body.payeeName !== undefined) {
    const v = cleanText(body.payeeName);
    if (v.length < 2) errors.payeeName = 'Enter the payee name'; else updates.name = v;
  }
  if (body.upiId !== undefined) {
    const v = String(body.upiId).trim();
    if (!UPI_ID_PATTERN.test(v)) errors.upiId = 'Enter a valid UPI ID, for example name@bank'; else updates.upiId = v;
  }
  if (body.clearBankQr === true) {
    updates.upiParams = {};
    updates.upiPayeeName = '';
  } else if (body.bankQr) {
    // The text inside the QR the bank issued for this account. Its UPI ID becomes the payment UPI ID.
    const parsed = qrHelper.parseBankQr(body.bankQr);
    if (!parsed.ok) errors.bankQr = parsed.error;
    else if (Object.keys(parsed.params).length === 0) errors.bankQr = 'This QR has no merchant details, so there is nothing to add. It looks like a personal UPI QR.';
    else {
      updates.upiId = parsed.upiId;
      updates.upiPayeeName = cleanText(parsed.payeeName, 100);
      updates.upiParams = parsed.params;
    }
  }
  if (body.loginEmail !== undefined) {
    const v = String(body.loginEmail).trim().toLowerCase();
    const taken = store.getMerchantByEmail(v);
    if (!EMAIL_PATTERN.test(v)) errors.loginEmail = 'Enter a valid sign-in email';
    else if (taken && taken.id !== merchant.id) errors.loginEmail = 'Another account already uses this email';
    else updates.email = v;
  }
  if (body.gmailUser !== undefined) {
    const v = String(body.gmailUser).trim().toLowerCase();
    if (v && !EMAIL_PATTERN.test(v)) errors.gmailUser = 'Enter a valid Gmail address'; else updates.gmailUser = v;
  }
  if (body.clearGmailAppPass === true) {
    updates.gmailAppPass = '';
  } else if (body.gmailAppPass) {
    const v = String(body.gmailAppPass).replace(/\s+/g, '');
    if (v.length !== 16) errors.gmailAppPass = 'A Gmail App Password has 16 characters'; else updates.gmailAppPass = v;
  }
  if (body.allowedSenders !== undefined) {
    const list = (Array.isArray(body.allowedSenders) ? body.allowedSenders : String(body.allowedSenders).split(/[\s,;]+/))
      .map(s => String(s).toLowerCase().trim().replace(/^@/, ''))
      .filter(Boolean);
    const bad = list.find(s => !/^([^\s@]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s));
    if (bad) errors.allowedSenders = `"${bad}" is not an email address or domain`;
    else if (list.length > 20) errors.allowedSenders = 'Use 20 senders or fewer';
    else updates.allowedSenders = [...new Set(list)];
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, error: Object.values(errors)[0], errors });
  }

  const gmailChanged =
    (updates.gmailUser !== undefined && updates.gmailUser !== (merchant.gmailUser || '')) ||
    (updates.gmailAppPass !== undefined && updates.gmailAppPass !== (merchant.gmailAppPass || ''));

  const updated = store.updateMerchant(merchant.id, updates);

  if (gmailChanged) {
    if (updated.gmailUser && updated.gmailAppPass) watcherManager.restart(updated);
    else watcherManager.remove(updated.id);
  }

  res.json({
    success: true,
    gmailRestarted: gmailChanged,
    merchant: store.publicMerchant(updated),
    ...settingsPayload(updated)
  });
});

// Live status of the Gmail IMAP stream
app.get('/api/merchant/imap', requireAuth, (req, res) => {
  res.json({
    success: true,
    canHoldImapStream: !process.env.VERCEL,
    status: watcherStatusFor(req.merchant)
  });
});

// Drop the Gmail connection and connect again with the saved details
app.post('/api/merchant/imap/restart', requireAuth, (req, res) => {
  const merchant = req.merchant;
  if (!merchant.gmailUser || !merchant.gmailAppPass) {
    return res.status(400).json({ error: 'Add a Gmail address and App Password in Settings first' });
  }
  watcherManager.restart(merchant);
  res.json({ success: true, status: watcherStatusFor(merchant) });
});

// ==============================================================
// 5. PUBLIC DEVELOPER API & PAYWALL ENDPOINTS
// ==============================================================

// Create checkout order via API Key.
// With PUBLIC_CHECKOUT=true, /pay/new and /test/new may also create orders for the main merchant without a key.
app.post('/api/v1/checkout/create', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));

  let merchant = null;
  if (apiKey) {
    merchant = store.getMerchantByApiKey(apiKey);
    if (!merchant) return res.status(403).json({ error: 'Invalid API Key' });
  } else if (envFlag('PUBLIC_CHECKOUT')) {
    merchant = store.getMerchantById(DEFAULT_MERCHANT_ID);
  }
  if (!merchant) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const { amount, customerName, customerEmail, note } = req.body || {};
  const numAmount = parseAmount(amount, 199.00);
  if (numAmount === null) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const order = await createOrderFor(merchant, {
    amount: numAmount,
    customerName: cleanText(customerName),
    customerEmail: cleanText(customerEmail, 120),
    note: cleanText(note, 80)
  });

  // Ensure watcher is active
  watcherManager.getOrCreate(merchant);

  res.json({
    success: true,
    orderId: order.orderId,
    amount: order.amount,
    currency: 'INR',
    status: order.status,
    checkoutUrl: `${req.protocol}://${req.get('host')}/pay/${order.orderId}`,
    dynamicUpiUrl: order.dynamicUpiUrl,
    dynamicQrDataUrl: order.dynamicQrDataUrl
  });
});

// Get Public Checkout Details
app.get('/api/v1/checkout/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const merchant = store.getMerchantById(order.merchantId);

  // If dynamic QR wasn't pre-generated, generate it now
  if (!order.dynamicQrDataUrl && merchant) {
    const { upiUri, qrDataUrl } = await paymentRequestFor(merchant, {
      amount: order.amount,
      note: order.note,
      orderId: order.orderId
    });
    order.dynamicUpiUrl = upiUri;
    order.dynamicQrDataUrl = qrDataUrl;
    store.updateOrder(orderId, { dynamicUpiUrl: upiUri, dynamicQrDataUrl: qrDataUrl });
  }

  res.json({
    success: true,
    order: {
      orderId: order.orderId,
      amount: order.amount,
      customerName: order.customerName,
      note: order.note,
      status: order.status,
      dynamicUpiUrl: order.dynamicUpiUrl,
      dynamicQrDataUrl: order.dynamicQrDataUrl,
      verifiedAt: order.verifiedAt,
      paymentDetails: order.paymentDetails,
      customerDetailsCollected: Boolean(order.customerDetailsAt)
    },
    merchant: {
      businessName: merchant ? merchant.businessName : 'Merchant Payee',
      upiId: merchant ? merchant.upiId : '',
      qrImagePath: merchant ? merchant.qrImagePath : '/uploads/default-qr.jpeg'
    }
  });
});

// Save customer contact details entered on the checkout page (before payment)
app.post('/api/v1/checkout/:orderId/customer', (req, res) => {
  const order = store.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING') {
    return res.status(409).json({ error: 'This order is already completed' });
  }

  const body = req.body || {};
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  const email = String(body.email || '').trim().toLowerCase();
  // Accept "+91 98765 43210", "09876543210", "9876543210" and keep the 10-digit number
  const phone = String(body.phone || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

  const errors = {};
  if (name.length < 2 || name.length > 80) errors.name = 'Enter your full name';
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid 10-digit mobile number';
  if (email.length > 120 || !EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, error: Object.values(errors)[0], errors });
  }

  store.updateOrder(order.orderId, {
    customerName: name,
    customerPhone: phone,
    customerEmail: email,
    customerDetailsAt: new Date().toISOString()
  });

  res.json({ success: true });
});

// Check payment verification status for an order
app.get('/api/v1/checkout/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'PAID') {
    return res.json({
      success: true,
      verified: true,
      order
    });
  }

  // Force quick check via watcher
  const merchant = store.getMerchantById(order.merchantId);
  if (merchant) {
    const watcher = watcherManager.getOrCreate(merchant);
    if (watcher) {
      await watcher.syncAndProcess(15);
    }
  }

  const refreshed = store.getOrder(orderId);
  return res.json({
    success: true,
    verified: refreshed.status === 'PAID',
    order: refreshed
  });
});

// Secure Digital Delivery Endpoint (Requires Verified Payment)
app.get('/api/v1/checkout/delivery/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status !== 'PAID') {
    return res.status(403).json({
      error: 'Access Denied',
      message: 'Payment has not been completed or verified yet. Please complete payment first.'
    });
  }

  const DRIVE_VIEW_URL = 'https://drive.google.com/file/d/17kwNVuo_KY9XiRi5ohNXdo93CeQr0d3I/view?usp=sharing';
  const DRIVE_DOWNLOAD_URL = 'https://drive.google.com/uc?export=download&id=17kwNVuo_KY9XiRi5ohNXdo93CeQr0d3I';
  const targetUrl = req.query.download === '1' ? DRIVE_DOWNLOAD_URL : DRIVE_VIEW_URL;

  if (req.xhr || req.headers.accept?.includes('application/json') || req.query.format === 'json') {
    return res.json({
      success: true,
      verified: true,
      deliveryUrl: DRIVE_VIEW_URL,
      downloadUrl: DRIVE_DOWNLOAD_URL
    });
  }

  return res.redirect(targetUrl);
});

// Dedicated SSE Stream for an order checkout
app.get('/api/v1/checkout/events/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).end();

  // No Gmail watcher configured: nothing will ever be sent, so don't hold the connection open
  const merchant = store.getMerchantById(order.merchantId);
  const watcher = merchant ? watcherManager.getOrCreate(merchant) : null;
  if (!watcher) return res.status(204).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  watcher.subscribeOrder(orderId, res);
});

// Manual UTR submission on paywall
app.post('/api/v1/checkout/verify-utr', async (req, res) => {
  const { orderId, utr } = req.body || {};
  if (!orderId || !utr) {
    return res.status(400).json({ error: 'Order ID and UTR required' });
  }

  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const merchant = store.getMerchantById(order.merchantId);
  const watcher = merchant ? watcherManager.getOrCreate(merchant) : null;
  if (!watcher) {
    return res.json({
      success: false,
      verified: false,
      message: 'Automatic verification is not set up for this merchant yet.'
    });
  }

  await watcher.syncAndProcess(25);

  const cleanUtr = String(utr).trim().toLowerCase();
  const matched = watcher.recentPayments.find(p => {
    const pUtr = (p.utr || '').toLowerCase();
    const pTxn = (p.txnId || '').toLowerCase();
    const pSnippet = (p.snippet || '').toLowerCase();
    return (pUtr.includes(cleanUtr) || pTxn.includes(cleanUtr) || pSnippet.includes(cleanUtr)) &&
           Math.abs(p.amount - order.amount) < 0.01 &&
           !watcher.isPaymentClaimed(p);
  });

  if (matched) {
    watcher.executeOrderMatch(order, matched, 'MANUAL_UTR_CONFIRMATION');
    const updated = store.getOrder(orderId);
    return res.json({
      success: true,
      verified: true,
      order: updated
    });
  }

  return res.json({
    success: false,
    verified: false,
    message: 'UTR not yet detected in inbox. Please allow a few seconds for the bank email alert.'
  });
});

// Simulation endpoint to test concurrent payments.
// Signed-in merchants only: it marks orders as paid without any real money moving.
app.post('/api/v1/simulate-payment', requireAuth, (req, res) => {
  const { amount = 5, payerName = 'Concurrent Tester', utr } = req.body || {};
  const merchant = req.merchant;

  const watcher = watcherManager.getOrCreate(merchant);
  if (!watcher) {
    return res.status(400).json({ error: 'Connect a Gmail inbox in Settings before running the simulator.' });
  }

  const simulatedPayment = {
    uid: Math.floor(10000 + Math.random() * 90000),
    amount: parseFloat(amount),
    senderName: cleanText(payerName),
    utr: utr || Math.floor(100000000000 + Math.random() * 900000000000).toString(),
    txnId: `FMPIB${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    date: new Date(),
    rawSubject: `You received ₹${amount} in your account`,
    snippet: `You have successfully received ₹${amount} from ${cleanText(payerName)}.`,
    source: 'Simulation Engine'
  };

  watcher.handleIncomingPayment(simulatedPayment);

  res.json({
    success: true,
    simulatedPayment
  });
});

// ==============================================================
// 6. HOSTED PAYWALL ROUTE
// ==============================================================

app.get(['/pay/:orderId', '/checkout/:orderId', '/test/:orderId', '/test'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paywall.html'));
});

// Merchant dashboard (its own page; it asks for sign-in itself)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Unknown API routes answer with JSON, not the web page
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Fallback to Main Dashboard / Landing SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Errors (bad JSON, oversized upload, unexpected failures) answer with JSON
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[Server] Unhandled error:', err.message);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

// Run as a normal server with `node server.js`; on Vercel the app is imported by api/index.js instead
if (require.main === module) {
  app.listen(PORT, () => {
    const admin = store.getMerchantById(DEFAULT_MERCHANT_ID);
    console.log(`====================================================`);
    console.log(`🚀 AuraPay Platform running at: http://localhost:${PORT}`);
    console.log(`💼 Active Merchant: ${admin ? admin.businessName : 'N/A'}`);
    console.log(`📧 Monitoring Email: ${admin && admin.gmailAppPass ? admin.gmailUser : 'not configured'}`);
    console.log(`🔐 Dashboard sign-in: ${admin ? admin.email : 'N/A'}`);
    if (admin && !process.env.ADMIN_PASSWORD && !admin.password) {
      console.log(`⚠️  No dashboard password is set. Add ADMIN_PASSWORD to .env and restart.`);
    }
    console.log(`====================================================`);
  });
}

module.exports = app;
