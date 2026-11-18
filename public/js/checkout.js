/**
 * KPay QR — NPCI Compliant UPI URI & App Intent Link Builder (public/js/checkout.js)
 *
 * Implements KPay P2P intent architecture:
 * - Oromits `mode` and merchant-only tags (`tr`, `mc`) for personal accounts
 *   to eliminate PhonePe / "Paytm Protect" and NPCI UPI Risk Policy alerts ("This payment may fail as per UPI Risk Policy...").
 * - Builds direct deep-links for PhonePe, Google Pay (Tez), Paytm, CRED, Amazon Pay, WhatsApp, and UPI Number intent.
 */

function buildIntentLinks(upiUri, mobileNumber) {
  const queryString = (upiUri || '').replace(/^upi:\/\/pay\??/, '');

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

function setupUpiIntentLinks(order) {
  if (!order) return;

  const rawUri = order.upiUri || order.dynamicUpiUrl || '';
  if (!rawUri) return;

  const queryString = rawUri.replace(/^upi:\/\/pay\??/, '');
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  
  // Extract 10-digit mobile if payee UPI ID is formatted as <phone>@fam / <phone>@upi
  const payeeVpa = order.upiId || '8789601387@fam';
  const mobileMatch = payeeVpa.match(/^([6-9]\d{9})/);
  const mobileNumber = mobileMatch ? mobileMatch[1] : '8789601387';

  const links = buildIntentLinks(rawUri, mobileNumber);

  // 1. Universal / Direct UPI Intent
  const btnPayDirect = document.getElementById('btnPayDirect');
  if (btnPayDirect) {
    btnPayDirect.href = links.generic;
  }

  // 2. PhonePe (Direct deep-link — now clean P2P without tr/mode to bypass risk alert)
  const btnPhonePe = document.getElementById('btnPhonePe');
  if (btnPhonePe) {
    btnPhonePe.href = links.phonepe;
  }

  // 3. Google Pay (Tez scheme)
  const btnGPay = document.getElementById('btnGPay');
  if (btnGPay) {
    btnGPay.href = links.gpay;
  }

  // 4. Paytm
  const btnPaytm = document.getElementById('btnPaytm');
  if (btnPaytm) {
    btnPaytm.href = isAndroid
      ? `intent://pay?${queryString}#Intent;scheme=upi;package=net.one97.paytm;end`
      : links.paytm;
  }

  // 5. CRED
  const btnCred = document.getElementById('btnCred');
  if (btnCred) {
    btnCred.href = links.cred;
  }

  // 6. WhatsApp Pay
  const btnWhatsApp = document.getElementById('btnWhatsApp');
  if (btnWhatsApp) {
    btnWhatsApp.href = isAndroid
      ? links.whatsapp
      : `whatsapp://pay?${queryString}`;
  }
}

if (typeof window !== 'undefined') {
  window.buildIntentLinks = buildIntentLinks;
  window.setupUpiIntentLinks = setupUpiIntentLinks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildIntentLinks, setupUpiIntentLinks };
}
