/**
 * server.js — API de WhatsApp (capa propia) sobre el motor WAHA.
 *
 * Rol: expone DOS caras sobre la misma sesión de WhatsApp que maneja WAHA:
 *   A) Fachada legacy — rutas HTTP con el MISMO contrato de la versión anterior
 *      (/qr, /status, /connect, /disconnect, /send-message, /send-message-get),
 *      para que los sistemas que ya las consumen no cambien nada.
 *   B) Web UI en '/' — página para escanear el QR, ver el estado y enviar mensajes.
 *
 * No habla con WhatsApp directamente: todo pasa por ./wahaClient.js. Al arrancar
 * intenta enganchar la sesión de WAHA (con reintentos, porque el contenedor de
 * WAHA puede tardar en levantar), de modo que `docker compose up` reconecta solo
 * si la sesión ya estaba guardada en el volumen persistente.
 *
 * Config por entorno: PORT (default 80) + las de wahaClient.js (WAHA_URL,
 * WAHA_SESSION, WAHA_API_KEY). Requiere Node 18+ (fetch global).
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const waha = require('./wahaClient');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Normaliza un número a chatId de WhatsApp: solo dígitos + sufijo @c.us.
function toChatId(number) {
  return `${String(number).replace(/[^0-9]/g, '')}@c.us`;
}

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Fachada legacy (contrato idéntico a la versión anterior)
// ---------------------------------------------------------------------------

// Estado del cliente -> { ready }
app.get('/status', async (req, res) => {
  try {
    res.json({ ready: await waha.isReady() });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// QR como dataURL -> { qr }. 404 si no hay QR (ya conectado o sin arrancar).
app.get('/qr', async (req, res) => {
  try {
    if (await waha.isReady()) return res.status(404).json({ error: 'QR no disponible' });
    const qr = await waha.getQrDataUrl();
    if (!qr) return res.status(404).json({ error: 'QR no disponible' });
    res.json({ qr });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Forzar (re)conexión / generar QR.
app.post('/connect', async (req, res) => {
  try {
    await waha.ensureStarted();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Detener la sesión (conserva la autenticación).
app.post('/disconnect', async (req, res) => {
  try {
    await waha.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Cerrar sesión de verdad (borra auth, fuerza nuevo QR). Usado por la web UI.
app.post('/logout', async (req, res) => {
  try {
    await waha.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Enviar mensaje (texto y opcional archivo) vía multipart/form-data.
app.post('/send-message', upload.single('file'), async (req, res) => {
  const { number, message } = req.body;
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !req.file) return res.status(400).json({ error: 'message o file es requerido' });

  try {
    if (!(await waha.isReady())) {
      return res.status(409).json({ error: 'WhatsApp no está conectado' });
    }
    const chatId = toChatId(number);
    let id;
    if (req.file) {
      id = await waha.sendMedia(
        chatId,
        {
          mimetype: req.file.mimetype,
          filename: req.file.originalname,
          data: req.file.buffer.toString('base64'),
        },
        message
      );
    } else {
      id = await waha.sendText(chatId, message);
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('send error', err);
    res.status(500).json({ error: String(err) });
  }
});

// Enviar mensaje vía GET (params: number, message, file base64, fileName, fileType).
app.get('/send-message-get', async (req, res) => {
  const { number, message, file, fileName, fileType } = req.query;
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !file) return res.status(400).json({ error: 'message o file es requerido' });

  try {
    if (!(await waha.isReady())) {
      return res.status(409).json({ error: 'WhatsApp no está conectado' });
    }
    const chatId = toChatId(number);
    let id;
    if (file) {
      id = await waha.sendMedia(
        chatId,
        { mimetype: fileType || 'application/octet-stream', filename: fileName || 'file', data: file },
        message
      );
    } else {
      id = await waha.sendText(chatId, message);
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('send error (GET)', err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Arranque + enganche de la sesión de WAHA con reintentos
// ---------------------------------------------------------------------------
async function bootstrapSession(retries = 30, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await waha.ensureStarted();
      console.log('WAHA session ensured (intento', i + ')');
      return;
    } catch (err) {
      console.log(`WAHA aún no responde (intento ${i}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error('No se pudo enganchar la sesión de WAHA tras varios reintentos; se sigue sirviendo la API/UI.');
}

// Un crash de red no debe tumbar el proceso: se loguea y se sigue.
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  bootstrapSession();
});
