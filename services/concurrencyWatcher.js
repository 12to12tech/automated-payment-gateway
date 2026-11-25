const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { parsePaymentEmail } = require('./paymentParser');
const { OrderModel, getIsConnected } = require('./mongo');
const store = require('./store');

class ConcurrencyWatcher {
  constructor(config) {
    this.merchantId = config.merchantId;
    this.user = config.user;
    this.pass = config.pass.replace(/\s+/g, '');
    this.client = null;
    this.isConnected = false;
    this.isSyncing = false;
    this.pollInterval = null;
    this.lastSyncTime = null;
    
    // Concurrency tracking
    this.claimedPaymentKeys = new Set(); // UTR, TxnId, UID
    this.parsedUids = new Set(); // Fast deduplication cache
    this.highestUidSeen = 0;
    this.orderStreams = new Map(); // orderId -> Set of res objects (SSE)
    this.merchantStreams = new Set(); // merchant dashboard SSE listeners
    this.recentPayments = [];
    this.isProcessingQueue = false;

    // Live status shown in the dashboard
    this.state = 'connecting'; // connecting | connected | reconnecting | auth_failed | stopped
    this.connectedAt = null;
    this.lastError = null; // { message, at }
    this.mailboxCount = null;
    this.retryDelayMs = 3000;
    this.retryTimer = null;
    this.nextRetryAt = null;
    this.destroyed = false;
    this.stats = { emailsScanned: 0, paymentsDetected: 0, matched: 0, unmatched: 0, ignoredSender: 0, reconnects: 0 };
    this.events = []; // newest first, capped
  }

  logEvent(type, message) {
    this.events.unshift({ at: new Date().toISOString(), type, message });
    if (this.events.length > 60) this.events.pop();
  }

  recordError(err) {
    const message = (err && (err.responseText || err.message)) || 'Unknown error';
    // Avoid flooding the log with the same error every second
    if (!this.lastError || this.lastError.message !== message) {
      this.logEvent('error', message);
    }
    this.lastError = { message, at: new Date().toISOString() };
  }

  /** Senders this merchant accepts bank alerts from. Empty list = accept any sender. */
  allowedSenders() {
    const merchant = store.getMerchantById(this.merchantId);
    return (merchant && merchant.allowedSenders) || [];
  }

  createClient() {
    return new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.user,
        pass: this.pass
      },
      logger: false,
      emitLogs: false
    });
  }

  setupClientHandlers(client) {
    client.on('error', (err) => {
      console.error(`[Watcher:${this.merchantId}] IMAP error:`, err.message);
      this.isConnected = false;
      this.recordError(err);
    });

    client.on('close', () => {
      if (this.isConnected && !this.destroyed) {
        this.logEvent('warning', 'Connection to Gmail closed. Reconnecting...');
        this.state = 'reconnecting';
      }
      this.isConnected = false;
    });

    client.on('exists', (data) => {
      console.log(`[Watcher:${this.merchantId}] Immediate email push! Mailbox total: ${data.count}`);
      this.syncAndProcess(3).catch(() => {});
    });
  }

  async start() {
    if (this.destroyed) return;
    try {
      console.log(`[Watcher:${this.merchantId}] Connecting to IMAP for ${this.user}...`);
      this.state = 'connecting';
      this.nextRetryAt = null;
      this.client = this.createClient();
      this.setupClientHandlers(this.client);

      await this.client.connect();
      this.markConnected();
      console.log(`[Watcher:${this.merchantId}] Connected successfully!`);

      // Initial sync of the last 15 emails to populate parsedUids cache
      await this.syncAndProcess(15);

      // Background pulse: every second, a light check for new message UIDs
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        this.syncAndProcess(3).catch(() => {});
      }, 1000);

    } catch (err) {
      console.error(`[Watcher:${this.merchantId}] Initial connection failed:`, err.message);
      this.isConnected = false;
      this.handleConnectFailure(err);
      if (this.state !== 'auth_failed' && !this.destroyed) {
        this.retryTimer = setTimeout(() => this.start(), this.scheduleRetry());
      }
    }
  }

  markConnected() {
    this.isConnected = true;
    this.state = 'connected';
    this.connectedAt = new Date().toISOString();
    this.lastError = null;
    this.retryDelayMs = 3000;
    this.nextRetryAt = null;
    this.logEvent('success', `Connected to Gmail inbox ${this.user}`);
  }

  /** Wrong Gmail address / App Password: stop retrying so Google does not lock the account. */
  handleConnectFailure(err) {
    this.recordError(err);
    if (err && err.authenticationFailed) {
      this.state = 'auth_failed';
      this.nextRetryAt = null;
      this.logEvent('error', 'Gmail rejected the sign-in. Check the Gmail address and App Password in Settings.');
    } else {
      this.state = 'reconnecting';
    }
  }

  /** Wait longer after each failed attempt: 3s, 6s, 12s ... up to 60s. */
  scheduleRetry() {
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60000);
    this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    return delay;
  }

  async ensureConnected() {
    if (!this.client || !this.isConnected || !this.client.usable) {
      if (this.state === 'auth_failed') throw new Error('Gmail sign-in failed');
      if (this.nextRetryAt && new Date(this.nextRetryAt).getTime() > Date.now()) {
        throw new Error('Waiting before the next reconnect attempt');
      }
      try {
        if (this.client) {
          try { await this.client.logout(); } catch (e) {}
        }
        this.state = 'reconnecting';
        this.client = this.createClient();
        this.setupClientHandlers(this.client);
        await this.client.connect();
        this.stats.reconnects++;
        this.markConnected();
      } catch (err) {
        this.isConnected = false;
        this.handleConnectFailure(err);
        if (this.state !== 'auth_failed') this.scheduleRetry();
        throw err;
      }
    }
  }

  async syncAndProcess(limit = 3) {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      await this.ensureConnected();

      let lock = await this.client.getMailboxLock('INBOX');
      try {
        await this.client.noop();

        const total = this.client.mailbox.exists;
        this.mailboxCount = total;
        if (total > 0) {
          const fetchCount = Math.min(total, limit);
          const start = Math.max(1, total - fetchCount + 1);
          const range = `${start}:${total}`;

          // Step 1 (cheap): list the UIDs only, so known emails are not downloaded again every second
          const newUids = [];
          for await (let msg of this.client.fetch(range, { uid: true })) {
            if (!this.parsedUids.has(msg.uid)) newUids.push(msg.uid);
          }

          // Step 2: download and read only the emails not seen before
          if (newUids.length > 0) {
            const fresh = [];
            for await (let msg of this.client.fetch(newUids.join(','), { source: true, uid: true }, { uid: true })) {
              fresh.push({ uid: msg.uid, source: msg.source });
            }
            for (const msg of fresh) {
              this.parsedUids.add(msg.uid);
              if (msg.uid > this.highestUidSeen) this.highestUidSeen = msg.uid;
              await this.processEmail(msg);
            }
          }
        }
      } finally {
        lock.release();
      }

      this.lastSyncTime = new Date();
    } catch (err) {
      if (this.isConnected) this.recordError(err);
      this.isConnected = false;
    } finally {
      this.isSyncing = false;
    }
  }

  async processEmail(msg) {
    try {
      this.stats.emailsScanned++;
      const parsed = await simpleParser(msg.source);
      const fromAddress = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '').toLowerCase();

      const payment = parsePaymentEmail(parsed.subject, parsed.text, parsed.html, parsed.date, msg.uid);
      if (!payment) return;

      // Only trust alerts from the senders the merchant listed (when a list is set)
      const allowed = this.allowedSenders();
      if (allowed.length > 0) {
        const verdict = checkSender(fromAddress, parsed.headers, allowed);
        if (!verdict.ok) {
          this.stats.ignoredSender++;
          this.logEvent('warning', `Ignored a payment-like email from ${fromAddress || 'unknown sender'}: ${verdict.reason}`);
          return;
        }
      }

      payment.fromAddress = fromAddress;
      this.stats.paymentsDetected++;
      this.logEvent('info', `Payment alert read: ₹${payment.amount} from ${fromAddress || 'unknown sender'} (ref ${payment.utr || payment.txnId || 'n/a'})`);
      await this.handleIncomingPayment(payment);
    } catch (pErr) {
      this.logEvent('warning', `Could not read an email: ${pErr.message}`);
    }
  }

  isPaymentClaimed(payment) {
    if (payment.uid && this.claimedPaymentKeys.has(`UID_${payment.uid}`)) return true;
    if (payment.utr && this.claimedPaymentKeys.has(`UTR_${payment.utr}`)) return true;
    if (payment.txnId && this.claimedPaymentKeys.has(`TXN_${payment.txnId}`)) return true;
    return false;
  }

  claimPayment(payment, orderId) {
    if (payment.uid) this.claimedPaymentKeys.add(`UID_${payment.uid}`);
    if (payment.utr) this.claimedPaymentKeys.add(`UTR_${payment.utr}`);
    if (payment.txnId) this.claimedPaymentKeys.add(`TXN_${payment.txnId}`);
    payment.claimedByOrder = orderId;
    payment.claimedAt = new Date();
  }

  /**
   * CONCURRENCY ENGINE:
   * Safely matches incoming payments with active pending orders without collisions
   */
  async handleIncomingPayment(payment) {
    // Check if already in cache
    const existsInCache = this.recentPayments.find(p =>
      (payment.uid && p.uid === payment.uid) ||
      (payment.utr && p.utr === payment.utr && Math.abs(p.amount - payment.amount) < 0.01)
    );
    if (!existsInCache) {
      this.recentPayments.unshift(payment);
      if (this.recentPayments.length > 50) this.recentPayments.pop();
    }

    // If this payment has already been claimed for an order, ignore
    if (this.isPaymentClaimed(payment)) {
      return;
    }

    // Direct live query to MongoDB Atlas so orders created from Appwrite/Vercel are immediately visible!
    let pendingOrders = [];
    if (getIsConnected()) {
      try {
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
        pendingOrders = await OrderModel.find({
          merchantId: this.merchantId,
          status: 'PENDING',
          createdAt: { $gte: thirtyMinsAgo }
        }).lean();
      } catch (err) {
        console.warn('[ConcurrencyEngine] Could not fetch from MongoDB, fallback to local store:', err.message);
        pendingOrders = store.getPendingOrdersByMerchant(this.merchantId);
      }
    } else {
      // No MongoDB: use the local store straight away instead of waiting for a database timeout
      pendingOrders = store.getPendingOrdersByMerchant(this.merchantId);
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      return;
    }

    const paymentTime = new Date(payment.date).getTime();
    const pUtr = (payment.utr || '').toLowerCase();
    const pSnippet = (payment.snippet || '').toLowerCase();

    // 1. First Pass: Check for explicit Order ID match in payment snippet / note
    for (const order of pendingOrders) {
      const orderRef = order.orderId.toLowerCase();
      // Merchant payment requests carry the order ID without dashes (PAY123456789)
      if (pSnippet.includes(orderRef) || pSnippet.includes(orderRef.replace(/[^a-z0-9]/g, ''))) {
        if (Math.abs(order.amount - payment.amount) < 0.01) {
          await this.executeOrderMatch(order, payment, 'EXPLICIT_ORDER_REF');
          return;
        }
      }
    }

    // 2. Second Pass: Smart candidate matching
    // Filter pending orders matching amount and within active 20-minute window
    const TWENTY_MINUTES_MS = 20 * 60 * 1000;
    const CLOCK_SKEW_MS = 180 * 1000; // 3 minutes skew tolerance

    const candidates = [];
    for (const order of pendingOrders) {
      const orderCreatedAt = new Date(order.createdAt).getTime();
      const orderStart = orderCreatedAt - CLOCK_SKEW_MS;
      const orderExpiry = orderCreatedAt + TWENTY_MINUTES_MS;

      if (Math.abs(order.amount - payment.amount) < 0.01) {
        if (paymentTime >= orderStart && paymentTime <= orderExpiry) {
          const hasActiveSSE = this.orderStreams.has(order.orderId) && this.orderStreams.get(order.orderId).size > 0;
          const timeDiff = Math.abs(paymentTime - orderCreatedAt);
          candidates.push({
            order,
            hasActiveSSE,
            timeDiff
          });
        }
      }
    }

    if (candidates.length === 0) {
      console.log(`[ConcurrencyEngine] Received payment ₹${payment.amount} (UTR: ${payment.utr || payment.txnId}) but no pending order in window matched.`);
      this.stats.unmatched++;
      this.logEvent('warning', `₹${payment.amount} received but no waiting order has that exact amount`);
      return;
    }

    // Sort priority:
    // 1. Orders actively being watched in open browser SSE streams
    // 2. Orders closest in time to the payment creation time
    candidates.sort((a, b) => {
      if (a.hasActiveSSE && !b.hasActiveSSE) return -1;
      if (!a.hasActiveSSE && b.hasActiveSSE) return 1;
      return a.timeDiff - b.timeDiff;
    });

    const chosen = candidates[0].order;
    const matchType = candidates[0].hasActiveSSE ? 'ACTIVE_BROWSER_MATCH' : 'CLOSEST_TIME_MATCH';
    await this.executeOrderMatch(chosen, payment, matchType);
  }

  async executeOrderMatch(order, payment, matchType) {
    this.claimPayment(payment, order.orderId);
    
    // 1. Instantly write to MongoDB Atlas (skipped when no database is connected)
    if (getIsConnected()) try {
      await OrderModel.findOneAndUpdate(
        { orderId: order.orderId },
        {
          $set: {
            status: 'PAID',
            verifiedAt: new Date(),
            paymentDetails: payment
          }
        }
      );
    } catch(err) {
      console.error('[ConcurrencyEngine] MongoDB Atlas update error:', err.message);
    }

    // 2. Update local store
    const updatedOrder = store.updateOrder(order.orderId, {
      status: 'PAID',
      verifiedAt: new Date().toISOString(),
      paymentDetails: payment
    }) || order;

    console.log(`[ConcurrencyEngine] ✓ ORDER MATCHED [${matchType}]: Order ${order.orderId} (₹${order.amount}) -> UTR ${payment.utr || payment.txnId}`);
    this.stats.matched++;
    this.logEvent('success', `Order ${order.orderId} marked paid: ₹${order.amount} (ref ${payment.utr || payment.txnId || 'n/a'})`);

    // Notify dedicated order SSE stream
    this.notifyOrder(order.orderId, {
      type: 'PAYMENT_SUCCESS',
      order: updatedOrder,
      payment
    });

    // Notify merchant dashboard
    this.notifyMerchant({
      type: 'TRANSACTION_VERIFIED',
      order: updatedOrder,
      payment
    });
  }

  /**
   * Subscribe an SSE response object to an order
   */
  subscribeOrder(orderId, res) {
    if (!this.orderStreams.has(orderId)) {
      this.orderStreams.set(orderId, new Set());
    }
    this.orderStreams.get(orderId).add(res);

    res.on('close', () => {
      const set = this.orderStreams.get(orderId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.orderStreams.delete(orderId);
      }
    });
  }

  notifyOrder(orderId, payload) {
    const clients = this.orderStreams.get(orderId);
    if (clients) {
      const msg = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) {
        try { res.write(msg); } catch (e) {}
      }
    }
  }

  subscribeMerchant(res) {
    this.merchantStreams.add(res);
    res.on('close', () => {
      this.merchantStreams.delete(res);
    });
  }

  notifyMerchant(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.merchantStreams) {
      try { res.write(msg); } catch (e) {}
    }
  }

  getStatus() {
    return {
      configured: true,
      state: this.isConnected ? 'connected' : this.state,
      connected: this.isConnected,
      user: this.user,
      connectedAt: this.isConnected ? this.connectedAt : null,
      lastSyncTime: this.lastSyncTime,
      lastError: this.lastError,
      nextRetryAt: this.isConnected ? null : this.nextRetryAt,
      mailboxCount: this.mailboxCount,
      stats: { ...this.stats },
      allowedSenders: this.allowedSenders(),
      activeQueuedOrders: store.getPendingOrdersByMerchant(this.merchantId).length,
      claimedCount: this.claimedPaymentKeys.size,
      recentPayments: this.recentPayments.slice(0, 10).map(p => ({
        amount: p.amount,
        senderName: p.senderName,
        utr: p.utr,
        txnId: p.txnId,
        date: p.date,
        fromAddress: p.fromAddress || null,
        source: p.source,
        claimedByOrder: p.claimedByOrder || null
      })),
      events: this.events.slice(0, 40)
    };
  }

  destroy() {
    this.destroyed = true;
    this.state = 'stopped';
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.client) {
      try { this.client.logout().catch(() => {}); } catch (e) {}
    }
  }
}

/**
 * Is this email from a sender the merchant trusts?
 * `allowed` entries are full addresses (alerts@bank.com) or domains (bank.com).
 * Gmail's own verdict (Authentication-Results) must also say the sender is genuine.
 */
function checkSender(fromAddress, headers, allowed) {
  const addr = (fromAddress || '').toLowerCase();
  const domain = addr.split('@')[1] || '';
  const listed = allowed.some(entry => {
    const e = String(entry).toLowerCase().trim().replace(/^@/, '');
    if (!e) return false;
    return e.includes('@') ? addr === e : (domain === e || domain.endsWith(`.${e}`));
  });
  if (!listed) return { ok: false, reason: 'sender is not in your allowed senders list' };

  let authResults = headers && headers.get ? headers.get('authentication-results') : '';
  if (Array.isArray(authResults)) authResults = authResults.join(' ');
  if (!/\b(dkim|dmarc)=pass\b/i.test(String(authResults || ''))) {
    return { ok: false, reason: 'Gmail could not confirm the email really came from that sender' };
  }
  return { ok: true };
}

// Global Manager for merchant watchers
class WatcherManager {
  constructor() {
    this.watchers = new Map(); // merchantId -> ConcurrencyWatcher
  }

  getOrCreate(merchant) {
    if (!merchant || !merchant.gmailUser || !merchant.gmailAppPass) return null;
    
    if (this.watchers.has(merchant.id)) {
      return this.watchers.get(merchant.id);
    }

    const watcher = new ConcurrencyWatcher({
      merchantId: merchant.id,
      user: merchant.gmailUser,
      pass: merchant.gmailAppPass
    });
    watcher.start();
    this.watchers.set(merchant.id, watcher);
    return watcher;
  }

  get(merchantId) {
    return this.watchers.get(merchantId) || null;
  }

  /** Stop the watcher for a merchant (e.g. Gmail details removed). */
  remove(merchantId) {
    const existing = this.watchers.get(merchantId);
    if (existing) {
      existing.destroy();
      this.watchers.delete(merchantId);
    }
  }

  /** Reconnect with the merchant's current Gmail details. Open browser streams are kept. */
  restart(merchant) {
    const existing = this.watchers.get(merchant.id);
    this.remove(merchant.id);
    const fresh = this.getOrCreate(merchant);
    if (fresh && existing) {
      fresh.orderStreams = existing.orderStreams;
      fresh.merchantStreams = existing.merchantStreams;
    }
    return fresh;
  }
}

module.exports = new WatcherManager();
module.exports.ConcurrencyWatcher = ConcurrencyWatcher; // exported for tests

