const QRCode = require('qrcode');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');

const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

// Fields that are set per order (or cannot be reused), so they are never copied from the bank's QR
const PER_ORDER_FIELDS = new Set(['pa', 'pn', 'am', 'mam', 'cu', 'tr', 'tn', 'sign']);

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (e) {
    return String(value);
  }
}

/**
 * Read the QR a bank issues for a merchant UPI ID, e.g.
 *   upi://pay?ver=01&mode=01&orgid=180071&pa=shop@bank&pn=SHOP PVT LTD&mc=2741&mid=...&mtid=...&qrMedium=04
 * Returns the UPI ID, the registered payee name and the merchant fields (mc, mid, mtid, orgid ...)
 * that UPI apps expect on every payment request to a merchant account.
 */
function parseBankQr(raw) {
  const text = String(raw || '').trim();
  if (!/^upi:\/\/pay\?/i.test(text)) {
    return { ok: false, error: 'This is not a UPI payment QR (it should start with upi://pay).' };
  }

  const fields = {};
  text.slice(text.indexOf('?') + 1).split('&').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    fields[pair.slice(0, eq).trim()] = safeDecode(pair.slice(eq + 1)).trim();
  });

  const upiId = fields.pa || '';
  if (!UPI_ID_PATTERN.test(upiId)) {
    return { ok: false, error: 'The QR does not contain a valid UPI ID.' };
  }
  if (fields.sign) {
    return { ok: false, error: 'This QR is digitally signed by the bank, so an amount cannot be added to it. Ask the bank for its dynamic QR service instead.' };
  }

  const params = {};
  Object.keys(fields).forEach(key => {
    if (PER_ORDER_FIELDS.has(key.toLowerCase())) return;
    if (!/^[a-zA-Z]{1,20}$/.test(key) || fields[key].length > 100 || Object.keys(params).length >= 20) return;
    params[key] = fields[key];
  });

  return { ok: true, upiId, payeeName: fields.pn || '', params };
}

/**
 * Generate a dynamic UPI payment URI.
 *
 * Personal UPI ID (no bankParams): the plain link this project always used.
 * Merchant UPI ID (bankParams from the bank's QR): the bank's merchant fields are included, because UPI
 * apps decline payments to a merchant account when they are missing. `purpose` is 'qr' for the code the
 * customer scans, or 'intent' for the tap-to-pay buttons (mode 04, no QR medium).
 */
function buildUpiUri({ upiId, payeeName, amount, note, orderId, bankParams, purpose = 'qr' }) {
  // 1. Payee VPA / UPI ID: Crucial - do NOT percent-encode '@' into '%40'!
  const cleanVpa = (upiId || '').trim();

  // 2. Payee Merchant Name: Format and sanitize
  const safeName = (payeeName || 'Merchant').replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const cleanName = encodeURIComponent(safeName);

  // 3. Amount: Fixed to 2 decimal places
  const cleanAmount = Number(amount || 1.00).toFixed(2);

  // 4. Transaction Reference & Note
  const orderCode = orderId || `PAY-${Date.now().toString().slice(-6)}`;
  const cleanNote = encodeURIComponent(note || `Pay ${orderCode}`);

  const merchantFields = bankParams && Object.keys(bankParams).length > 0 ? { ...bankParams } : null;
  if (!merchantFields) {
    // Standard NPCI UPI URI: mode=00 is required by strict UPI clients like Paytm
    return `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${encodeURIComponent(orderCode)}&tn=${cleanNote}&cu=INR&mode=00`;
  }

  if (purpose === 'intent') {
    merchantFields.mode = '04'; // opened from a link, not scanned
    delete merchantFields.qrMedium;
  }
  // Merchant references must be letters and digits only (max 35)
  const txnRef = orderCode.replace(/[^a-zA-Z0-9]/g, '').slice(0, 35);
  const bankPart = Object.entries(merchantFields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  // Plain letters, digits and spaces only: symbols such as the rupee sign in a remark can get a request declined
  const plainNote = String(note || `Pay ${txnRef}`).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || `Pay ${txnRef}`;

  return `upi://pay?pa=${cleanVpa}&pn=${cleanName}&${bankPart}&am=${cleanAmount}&cu=INR&tr=${txnRef}&tn=${encodeURIComponent(plainNote)}`;
}

/**
 * Generate dynamic QR Data URL with exact amount pre-configured.
 * `upiUri` is the link for the tap-to-pay buttons; `qrUri` is what the QR image encodes.
 * For a personal UPI ID the two are identical.
 */
async function generateDynamicQrDataUrl({ upiId, payeeName, amount, note, orderId, bankParams }) {
  const qrUri = buildUpiUri({ upiId, payeeName, amount, note, orderId, bankParams, purpose: 'qr' });
  const upiUri = buildUpiUri({ upiId, payeeName, amount, note, orderId, bankParams, purpose: 'intent' });

  // High quality QR generation with white border
  const qrDataUrl = await QRCode.toDataURL(qrUri, {
    errorCorrectionLevel: bankParams && Object.keys(bankParams).length > 0 ? 'M' : 'H', // longer merchant links stay scannable
    margin: 2,
    scale: 8,
    color: {
      dark: '#0F172A',
      light: '#FFFFFF'
    }
  });

  return { upiUri, qrUri, qrDataUrl };
}

/**
 * Inspect & decode an uploaded UPI QR image (a screenshot, or a photo of a printed or on-screen QR)
 */
async function decodeQrImage(filePath) {
  try {
    const base = await Jimp.read(filePath);

    // A clean screenshot decodes straight away; photos sometimes need a tighter crop, a resize or more contrast
    const attempts = [
      { scale: 1, contrast: 0 }, { scale: 1, contrast: 0.5 }, { scale: 2, contrast: 0 },
      { scale: 0.5, contrast: 0 }, { scale: 2, contrast: 0.5 }, { scale: 0.5, contrast: 0.5 }
    ];
    let raw = null;
    for (const attempt of attempts) {
      const image = base.clone().greyscale();
      if (attempt.scale !== 1) image.scale(attempt.scale);
      if (attempt.contrast) image.contrast(attempt.contrast);
      const code = jsQR(new Uint8ClampedArray(image.bitmap.data), image.bitmap.width, image.bitmap.height);
      if (code && code.data) {
        raw = code.data;
        break;
      }
    }

    if (!raw) {
      return {
        success: false,
        error: 'QR code could not be detected. Please ensure image is clear and contains a UPI QR.'
      };
    }

    const bank = parseBankQr(raw);
    let upiId = bank.ok ? bank.upiId : null;
    let payeeName = bank.ok ? bank.payeeName : null;

    // If raw data is directly an email-like UPI address (e.g. name@bank)
    if (!upiId && raw.includes('@')) {
      const directMatch = raw.match(/([a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+)/);
      if (directMatch) upiId = directMatch[1];
    }

    return {
      success: true,
      raw,
      upiId: upiId || null,
      payeeName: payeeName || null,
      bank: bank.ok ? { upiId: bank.upiId, payeeName: bank.payeeName, params: bank.params } : null,
      bankError: bank.ok ? null : bank.error
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  parseBankQr,
  buildUpiUri,
  generateDynamicQrDataUrl,
  decodeQrImage
};
