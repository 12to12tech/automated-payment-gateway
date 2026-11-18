/**
 * Mobile Deep-Link Handling (public/js/checkout.js)
 * 
 * On the checkout screen (/checkout/:orderCode or /pay/:orderCode), strips upi://pay? 
 * and constructs dedicated deep-links for verified, reliable UPI apps:
 * - Direct / Universal UPI Intent (btnPayDirect)
 * - Google Pay (btnGPay) using registered Tez scheme (tez://upi/pay?...)
 * - Paytm (btnPaytm) using Android package intent / iOS paytmmp:// fallback
 * - WhatsApp Pay (btnWhatsApp) using Android package intent / iOS whatsapp:// scheme
 */

function setupUpiIntentLinks(order) {
  if (!order) return;

  const rawUri = order.upiUri || order.dynamicUpiUrl || '';
  if (!rawUri) return;

  // Strip 'upi://pay?' prefix to extract the raw query parameters
  const upiParams = rawUri.replace(/^upi:\/\/pay\??/, '');
  const isAndroid = /Android/i.test(navigator.userAgent || '');

  // 1. Universal / Direct UPI Intent (opens system UPI app chooser)
  const btnPayDirect = document.getElementById('btnPayDirect');
  if (btnPayDirect) {
    btnPayDirect.href = rawUri;
  }

  // 2. Google Pay: Uses Google Pay's registered Tez scheme
  const btnGPay = document.getElementById('btnGPay');
  if (btnGPay) {
    btnGPay.href = `tez://upi/pay?${upiParams}`;
  }

  // 3. Paytm: Uses Android Intent URL with explicit package targeting on Android, fallback for iOS
  const btnPaytm = document.getElementById('btnPaytm');
  if (btnPaytm) {
    if (isAndroid) {
      btnPaytm.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=net.one97.paytm;end`;
    } else {
      btnPaytm.href = `paytmmp://pay?${upiParams}`;
    }
  }

  // 4. WhatsApp Pay: Opens native WhatsApp Payments on Android/iOS
  const btnWhatsApp = document.getElementById('btnWhatsApp');
  if (btnWhatsApp) {
    if (isAndroid) {
      btnWhatsApp.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=com.whatsapp;end`;
    } else {
      btnWhatsApp.href = `whatsapp://pay?${upiParams}`;
    }
  }
}

if (typeof window !== 'undefined') {
  window.setupUpiIntentLinks = setupUpiIntentLinks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setupUpiIntentLinks };
}
