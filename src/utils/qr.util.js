/**
 * KPay QR — NPCI Compliant UPI URI & App Intent Link Builder
 * 
 * Automatically handles the difference between:
 * 1. Personal Bank Accounts (P2P):
 *    Omits `mode` and merchant-only tags (`tr`, `mc`) to eliminate PhonePe / "Paytm Protect"
 *    and NPCI UPI Risk Policy alerts ("This payment may fail as per UPI Risk Policy...").
 * 2. Verified Merchant Accounts (P2M):
 *    Applies `mode=04` (locked non-editable amount), MCC code, and transaction references.
 */

const QRCode = require('qrcode');

/**
 * Builds an NPCI-compliant UPI URI.
 */
function buildUpiUri(request) {
  const vpa = (request.upiVpa || request.vpa || request.upiId || '8789601387@fam').trim();
  const name = (request.merchantName || request.name || request.payeeName || 'Apex Cloud and Payments')
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim();
  const amount = Number(request.amount || 1.00).toFixed(2);
  const orderId = request.orderCode || request.orderId || `ORD-${Date.now()}`;
  const note = request.note || `Pay ${orderId}`;
  const cleanNote = note.replace(/[^a-zA-Z0-9 \-]/g, '').trim().slice(0, 24);

  const isPersonal = request.accountType === 'personal' || (!request.mc && request.accountType !== 'merchant');

  // Base NPCI parameters (pa unencoded for @)
  const cleanVpa = vpa;
  const cleanName = encodeURIComponent(name);
  const cleanAmount = amount;
  const cleanNoteParam = encodeURIComponent(cleanNote);

  if (!isPersonal) {
    // ── Verified Merchant Flow (P2M) ──────────────────────────────────
    // mode=04 locks the amount in user's UPI app (NPCI spec for verified merchants).
    // MUST NOT be sent for personal P2P accounts as it triggers Paytm Protect & risk policy blocks.
    const mode = request.mode === 'open' ? '00' : (request.mode || '04');
    const txnRef = encodeURIComponent(orderId);
    let uri = `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&cu=INR&tr=${txnRef}&tn=${cleanNoteParam}&mode=${mode}`;
    if (request.mc) {
      uri += `&mc=${encodeURIComponent(request.mc)}`;
    }
    return uri;
  } else {
    // ── Personal Account Flow (P2P) ───────────────────────────────────
    // Clean, unflagged P2P transfer parameters.
    // Omit `mode` and `tr` to avoid merchant impersonation / NPCI Risk Policy blocks in PhonePe!
    return `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&cu=INR&tn=${cleanNoteParam}`;
  }
}

/**
 * Builds app-specific intent links for Indian mobile payment apps:
 * - PhonePe, Google Pay (Tez), Paytm, BHIM, CRED, Amazon Pay, WhatsApp, and direct UPI mobile intent.
 */
function buildIntentLinks(upiUri, mobileNumber) {
  const queryString = upiUri.replace(/^upi:\/\/pay\?/, '');

  const links = {
    generic: upiUri,
    phonepe: `phonepe://pay?${queryString}`,
    gpay: `tez://upi/pay?${queryString}`,
    paytm: `paytmmp://pay?${queryString}`,
    bhim: `upi://pay?${queryString}`,
    cred: `credpay://upi/pay?${queryString}`,
    amazonpay: `amazonpay://upi/pay?${queryString}`,
    whatsapp: `intent://pay?${queryString}#Intent;scheme=upi;package=com.whatsapp;end`
  };

  const cleanMobile = (mobileNumber || '').toString().trim().replace(/^\+91/, '');
  if (/^[6-9]\d{9}$/.test(cleanMobile)) {
    links.mobileIntent = `upi://pay?pa=${cleanMobile}@upi&cu=INR`;
  }

  return links;
}

/**
 * Generates both the UPI Intent URI and high-contrast Data URL QR code
 */
async function generateDynamicQrDataUrl(params) {
  const upiUri = buildUpiUri(params);

  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: 'H',
    margin: 2,
    scale: 8,
    color: {
      dark: '#0A0D14',
      light: '#FFFFFF'
    }
  });

  return { upiUri, qrDataUrl };
}

module.exports = {
  buildUpiUri,
  buildUPIUri: buildUpiUri,
  buildIntentLinks,
  generateDynamicQrDataUrl
};
