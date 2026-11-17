const QRCode = require('qrcode');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');

/**
 * Generate a dynamic UPI payment URI
 */
function buildUpiUri({ upiId, payeeName, amount, note, orderId }) {
  // NPCI strictly requires alphanumeric letters and single spaces without symbols like & or #
  const safeName = (payeeName || 'Monu Kumar').replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const cleanOrderId = (orderId || `PAY${Date.now().toString().slice(-6)}`).replace(/[^a-zA-Z0-9]/g, '');
  const safeNote = (note || cleanOrderId).replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const amtFormatted = parseFloat(amount).toFixed(2);
  
  // Standard NPCI UPI URI Scheme with unique tr (ref) and tn (note) for isolated verification
  return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(safeName)}&am=${amtFormatted}&cu=INR&tn=${encodeURIComponent(safeNote)}&tr=${encodeURIComponent(cleanOrderId)}`;
}

/**
 * Generate dynamic QR Data URL with exact amount pre-configured
 */
async function generateDynamicQrDataUrl({ upiId, payeeName, amount, note, orderId }) {
  const upiUri = buildUpiUri({ upiId, payeeName, amount, note, orderId });
  
  // High quality QR generation with white border
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: 'H',
    margin: 2,
    scale: 8,
    color: {
      dark: '#0F172A',
      light: '#FFFFFF'
    }
  });

  return { upiUri, qrDataUrl };
}

/**
 * Inspect & decode an uploaded FamPay / UPI QR image
 */
async function decodeQrImage(filePath) {
  try {
    const image = await Jimp.read(filePath);
    const code = jsQR(
      new Uint8ClampedArray(image.bitmap.data),
      image.bitmap.width,
      image.bitmap.height
    );

    if (code && code.data) {
      const raw = code.data;
      // Extract pa= (UPI ID)
      const paMatch = raw.match(/pa=([a-zA-Z0-9.\-_@]+)/i);
      const pnMatch = raw.match(/pn=([a-zA-Z0-9%.\-_]+)/i);

      let upiId = paMatch ? paMatch[1] : null;
      let payeeName = pnMatch ? decodeURIComponent(pnMatch[1]) : null;

      // If raw data is directly an email-like UPI address (e.g. 8789601387@fam)
      if (!upiId && raw.includes('@')) {
        const directMatch = raw.match(/([a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+)/);
        if (directMatch) upiId = directMatch[1];
      }

      return {
        success: true,
        raw,
        upiId: upiId || '8789601387@fam',
        payeeName: payeeName || 'FamPay Merchant'
      };
    }

    return {
      success: false,
      error: 'QR code could not be detected. Please ensure image is clear and contains a UPI QR.'
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  buildUpiUri,
  generateDynamicQrDataUrl,
  decodeQrImage
};
