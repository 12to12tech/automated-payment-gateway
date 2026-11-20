/**
 * Mobile Deep-Link Handling (public/js/checkout.js)
 * 
 * On the checkout screen (/checkout/:orderCode or /pay/:orderCode), strips upi://pay? 
 * and constructs dedicated deep-links for each major UPI app:
 * - Direct / Universal UPI Intent & FamPay
 * - Google Pay (tez:// scheme)
 * - PhonePe (phonepe:// scheme)
 * - Paytm (Android Intent package targeting / iOS paytmmp:// fallback)
 * - Navi (Android Intent scheme targeting com.naviapp)
 * - super.money (Android Intent scheme targeting money.super.payments)
 */

function setupUpiIntentLinks(order) {
  if (!order) return;

  const rawUri = order.upiUri || order.dynamicUpiUrl || '';
  if (!rawUri) return;

  // Strip 'upi://pay?' prefix to extract the raw query parameters
  const upiParams = rawUri.replace(/^upi:\/\/pay\??/, '');
  const isAndroid = /Android/i.test(navigator.userAgent || '');

  // 1. Universal / Direct UPI Intent & FamPay
  const btnPayDirect = document.getElementById('btnPayDirect');
  const btnFamPay = document.getElementById('btnFamPay');
  if (btnPayDirect) {
    btnPayDirect.href = rawUri;
  }
  if (btnFamPay) {
    btnFamPay.href = rawUri;
  }

  // 2. Google Pay: Uses Google Pay's registered Tez scheme
  const btnGPay = document.getElementById('btnGPay');
  if (btnGPay) {
    btnGPay.href = `tez://upi/pay?${upiParams}`;
  }

  // 3. PhonePe: Explicit Android Intent package targeting with clean P2P params (omits mode & tr to avoid risk rejection)
  const btnPhonePe = document.getElementById('btnPhonePe');
  if (btnPhonePe) {
    const vpaMatch = rawUri.match(/pa=([^&]+)/);
    const nameMatch = rawUri.match(/pn=([^&]+)/);
    const amtMatch = rawUri.match(/am=([^&]+)/);
    const noteMatch = rawUri.match(/tn=([^&]+)/);

    const cleanVpa = vpaMatch ? vpaMatch[1] : '8789601387@fam';
    const cleanName = nameMatch ? nameMatch[1] : 'Monu%20Kumar';
    const cleanAmt = amtMatch ? amtMatch[1] : Number(order.amount || 1.00).toFixed(2);
    const cleanNote = noteMatch ? noteMatch[1] : 'Test%20Payment';

    // PhonePe strictly accepts P2P params without mode=00 or merchant refs on personal handles
    const phonePeParams = `pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmt}&cu=INR&tn=${cleanNote}`;
    const phonePeIntentUrl = isAndroid
      ? `intent://pay?${phonePeParams}#Intent;scheme=upi;package=com.phonepe.app;end`
      : `phonepe://pay?${phonePeParams}`;

    btnPhonePe.href = phonePeIntentUrl;

    btnPhonePe.onclick = (e) => {
      if (isAndroid) {
        e.preventDefault();
        window.location.href = phonePeIntentUrl;
        setTimeout(() => {
          window.location.href = `phonepe://pay?${phonePeParams}`;
        }, 500);
      }
    };
  }

  // 4. Paytm: Uses Android Intent URL with explicit package targeting on Android, fallback for iOS
  const btnPaytm = document.getElementById('btnPaytm');
  if (btnPaytm) {
    if (isAndroid) {
      btnPaytm.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=net.one97.paytm;end`;
    } else {
      btnPaytm.href = `paytmmp://pay?${upiParams}`;
    }
  }

  // 5. Navi
  const btnNavi = document.getElementById('btnNavi');
  if (btnNavi) {
    if (isAndroid) {
      btnNavi.href = `intent://pay?${upiParams}#Intent;scheme=com.naviapp;end`;
    } else {
      btnNavi.href = rawUri;
    }
  }

  // 6. super.money
  const btnSuperMoney = document.getElementById('btnSuperMoney');
  if (btnSuperMoney) {
    if (isAndroid) {
      btnSuperMoney.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=money.super.payments;end`;
    } else {
      btnSuperMoney.href = rawUri;
    }
  }
}

if (typeof window !== 'undefined') {
  window.setupUpiIntentLinks = setupUpiIntentLinks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setupUpiIntentLinks };
}
