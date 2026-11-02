import QRCode from 'qrcode';
const [text] = process.argv.slice(2);
const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
console.log(JSON.stringify({ size: q.modules.size, data: Array.from(q.modules.data) }));
