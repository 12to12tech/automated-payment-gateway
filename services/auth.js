/**
 * Merchant authentication: password hashing, signed session tokens, request guard.
 * Uses only Node's built-in crypto, so there is nothing extra to install.
 */
const crypto = require('crypto');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HASH_PREFIX = 'scrypt';

// ---------- Passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${HASH_PREFIX}$${salt}$${hash}`;
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(`${HASH_PREFIX}$`);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string' || password.length === 0) return false;
  if (!isHashed(stored)) return safeEqual(password, stored); // legacy plain-text record
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(candidate, hash);
}

// ---------- Session tokens (stateless, HMAC-signed) ----------

let secretProvider = () => process.env.SESSION_SECRET || '';

/** The store supplies a persisted random secret when SESSION_SECRET is not set. */
function setSecretProvider(fn) {
  secretProvider = fn;
}

function sign(payload) {
  return crypto.createHmac('sha256', secretProvider()).update(payload).digest('base64url');
}

function createToken(merchantId) {
  const payload = Buffer.from(JSON.stringify({ m: merchantId, e: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.') || !secretProvider()) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.m || !data.e || data.e < Date.now()) return null;
    return data.m;
  } catch (e) {
    return null;
  }
}

/**
 * Express guard. Accepts "Authorization: Bearer <token>", or ?token= for
 * EventSource connections, which cannot send headers.
 */
function requireAuth(store) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query && req.query.token);
    const merchantId = readToken(token);
    const merchant = merchantId ? store.getMerchantById(merchantId) : null;
    if (!merchant) {
      return res.status(401).json({ error: 'Please sign in again', code: 'UNAUTHENTICATED' });
    }
    req.merchant = merchant;
    next();
  };
}

// ---------- Simple in-memory login throttle ----------

const attempts = new Map(); // key -> { count, resetAt }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function loginBlocked(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.resetAt < Date.now()) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(key) {
  attempts.delete(key);
}

module.exports = {
  hashPassword,
  isHashed,
  verifyPassword,
  safeEqual,
  setSecretProvider,
  createToken,
  readToken,
  requireAuth,
  loginBlocked,
  recordLoginFailure,
  clearLoginFailures
};
