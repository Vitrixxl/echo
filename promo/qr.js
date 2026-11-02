// Prints a QR code's module matrix as JSON: bun --install=force qr.js TEXT [L|M|Q|H]
import QRCode from 'qrcode';
const [text, level = 'H'] = process.argv.slice(2);
const q = QRCode.create(text, { errorCorrectionLevel: level });
console.log(JSON.stringify({ size: q.modules.size, data: Array.from(q.modules.data) }));
