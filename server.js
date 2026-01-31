const express = require('express');
const cors = require('cors');
const multer = require('multer');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Usamos LocalAuth para persistir la sesión en ./sessions
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'default', dataPath: './sessions' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

let lastQr = null;
let ready = false;

client.on('qr', (qr) => {
  lastQr = qr;
  console.log('QR received');
});

client.on('ready', () => {
  ready = true;
  lastQr = null;
  console.log('WhatsApp client ready');
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure', msg);
  ready = false;
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
  ready = false;
});

client.initialize();

// Generar QR como DataURL
app.get('/qr', async (req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'QR no disponible' });
  try {
    const dataUrl = await qrcode.toDataURL(lastQr);
    res.json({ qr: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

// Estado del cliente
app.get('/status', (req, res) => {
  res.json({ ready });
});

// Forzar reconexión (útil si quieres regenerar QR)
app.post('/connect', (req, res) => {
  try {
    client.initialize();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    await client.destroy();
    ready = false;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Enviar mensaje (texto y opcional archivo)
app.post('/send-message', upload.single('file'), async (req, res) => {
  const { number, message } = req.body;
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !req.file) return res.status(400).json({ error: 'message o file es requerido' });

  // Normalizar número: mantener sólo dígitos
  const normalized = number.replace(/[^0-9]/g, '');
  const jid = `${normalized}@c.us`;

  try {
    if (req.file) {
      const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString('base64'), req.file.originalname);
      if (message) {
        const sent = await client.sendMessage(jid, media, { caption: message });
        return res.json({ ok: true, id: sent.id._serialized });
      } else {
        const sent = await client.sendMessage(jid, media);
        return res.json({ ok: true, id: sent.id._serialized });
      }
    } else {
      const sent = await client.sendMessage(jid, message);
      return res.json({ ok: true, id: sent.id._serialized });
    }
  } catch (err) {
    console.error('send error', err);
    return res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
