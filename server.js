const express = require('express');
const cors = require('cors');
const multer = require('multer');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLog(entry) {
  try {
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch (e) {
    console.error('Log write error', e);
  }
}

// Removed API key / token requirement: all routes are public now.

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  res.on('finish', () => {
    const duration = Date.now() - start;
    let body = null;
    try { if (chunks.length) body = Buffer.concat(chunks).toString(); } catch (e) { body = '<unreadable>'; }
    const entry = [
      `TIME: ${new Date().toISOString()}`,
      `IP: ${req.ip}`,
      `METHOD: ${req.method}`,
      `PATH: ${req.originalUrl}`,
      `STATUS: ${res.statusCode}`,
      `DURATION_MS: ${duration}`,
      `HEADERS: ${JSON.stringify(req.headers)}`,
      `BODY: ${body}`,
      '---'
    ].join('\n');
    appendLog(entry);
  });
  next();
});

// Cleanup helpers for Chromium lock files
function removeStaleLocksInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        removeStaleLocksInDir(p);
      } else {
        const name = e.name;
        if (/^Singleton/.test(name) || name === 'LOCK' || name.endsWith('.lock')) {
          try { fs.rmSync(p, { force: true }); appendLog(`CLEAN_LOCK removed ${p}`); } catch (er) { /* ignore */ }
        }
      }
    }
  } catch (err) { /* ignore */ }
}

function cleanupSessionLocks() {
  const sessionsRoot = path.join(__dirname, 'sessions');
  try {
    if (!fs.existsSync(sessionsRoot)) return;
    const dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const d of dirs) {
      const full = path.join(sessionsRoot, d);
      removeStaleLocksInDir(full);
    }
    removeStaleLocksInDir(sessionsRoot);
    appendLog('CLEANUP_SESSION_LOCKS completed');
  } catch (err) {
    appendLog('CLEANUP_SESSION_LOCKS error: ' + String(err));
  }
}

// WhatsApp client management (single active client for now)
let client = null;
let lastQr = null;
let ready = false;
let currentSession = 'default';

async function initClient(sessionId = 'default') {
  try {
    if (client) {
      try { await client.destroy(); } catch (e) { console.warn('Error destroying client', e); }
      client = null;
    }

    lastQr = null; ready = false; currentSession = sessionId;

    // prepare session folder and remove locks for this session
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    try { fs.mkdirSync(sessionPath, { recursive: true }); } catch (e) { /* ignore */ }
    removeStaleLocksInDir(sessionPath);

    client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: path.join(__dirname, 'sessions') }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-gpu',
          '--no-zygote',
          '--single-process'
        ]
      }
    });

    client.on('qr', (qr) => { lastQr = qr; appendLog(`QR_GENERATED session=${sessionId}`); });
    client.on('ready', () => { ready = true; lastQr = null; appendLog(`READY session=${sessionId}`); });
    client.on('auth_failure', (msg) => { ready = false; appendLog(`AUTH_FAILURE session=${sessionId} msg=${String(msg)}`); });
    client.on('disconnected', (reason) => { ready = false; appendLog(`DISCONNECTED session=${sessionId} reason=${String(reason)}`); });

    await client.initialize();
    appendLog(`INIT_CLIENT session=${sessionId}`);
    return true;
  } catch (err) {
    appendLog(`INIT_CLIENT_ERROR session=${sessionId} err=${String(err)}`);
    throw err;
  }
}

// Cleanup locks at startup
cleanupSessionLocks();
initClient('default').catch((e) => console.error('Init default client failed', e));

// Endpoints
app.get('/qr', async (req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'QR no disponible', session: currentSession });
  try {
    const dataUrl = await qrcode.toDataURL(lastQr);
    res.json({ qr: dataUrl, session: currentSession });
  } catch (err) { res.status(500).json({ error: 'Error generando QR' }); }
});

app.get('/status', (req, res) => res.json({ ready, session: currentSession }));

app.post('/connect', async (req, res) => {
  try { await initClient(currentSession); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/disconnect', async (req, res) => {
  try { if (client) { await client.destroy(); client = null; } ready = false; res.json({ ok: true }); } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Single session info endpoint
app.get('/session', (req, res) => {
  const sessionsDir = path.join(__dirname, 'sessions');
  try {
    const exists = fs.existsSync(sessionsDir);
    res.json({ session: currentSession, sessionsFolderExists: exists });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Delete the entire sessions folder and reinit default client
app.delete('/session', async (req, res) => {
  const sessionsRoot = path.join(__dirname, 'sessions');
  try {
    if (fs.existsSync(sessionsRoot)) {
      try { if (client) { await client.destroy(); client = null; } } catch (e) { /* ignore */ }
      fs.rmSync(sessionsRoot, { recursive: true, force: true });
      appendLog('SESSIONS_ROOT_DELETED');
    }
    try { await initClient('default'); } catch (e) { console.warn('Could not reinit default after delete', e); }
    return res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/send-message', upload.single('file'), async (req, res) => {
  const { number, message } = req.body;
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !req.file) return res.status(400).json({ error: 'message o file es requerido' });
  if (!client) return res.status(500).json({ error: 'Client no inicializado' });
  const normalized = number.replace(/[^0-9]/g, ''); const jid = `${normalized}@c.us`;
  try {
    if (req.file) {
      const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString('base64'), req.file.originalname);
      const sent = await client.sendMessage(jid, media, message ? { caption: message } : {});
      appendLog(`SENT_MEDIA to=${jid} session=${currentSession} id=${sent.id._serialized}`);
      return res.json({ ok: true, id: sent.id._serialized });
    } else {
      const sent = await client.sendMessage(jid, message);
      appendLog(`SENT_TEXT to=${jid} session=${currentSession} id=${sent.id._serialized}`);
      return res.json({ ok: true, id: sent.id._serialized });
    }
  } catch (err) { appendLog(`SEND_ERROR to=${jid} session=${currentSession} err=${String(err)}`); return res.status(500).json({ error: String(err) }); }
});

app.get('/logs', (req, res) => {
  const lines = parseInt(req.query.lines || '200', 10);
  try { if (!fs.existsSync(LOG_FILE)) return res.type('text/plain').send(''); const content = fs.readFileSync(LOG_FILE, 'utf8'); const arr = content.split('\n').filter(Boolean); const tail = arr.slice(-lines).join('\n'); res.type('text/plain').send(tail); } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Admin endpoint: limpiar locks de una sesión o de todas (protegido)
app.post('/admin/cleanup', async (req, res) => {
  const { sessionId } = req.body || {};
  try {
    if (sessionId) { removeStaleLocksInDir(path.join(__dirname, 'sessions', sessionId)); appendLog(`ADMIN_CLEAN session=${sessionId}`); }
    else { cleanupSessionLocks(); appendLog('ADMIN_CLEAN all sessions'); }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Server listening on port ${PORT}`); appendLog(`SERVER_START port=${PORT}`); });

