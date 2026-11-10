/**
 * server.js — API de WhatsApp (capa propia) sobre el motor WAHA.
 *
 * Rol: expone DOS caras sobre las sesiones de WhatsApp que maneja WAHA:
 *   A) Fachada legacy — rutas HTTP con el MISMO contrato de la versión anterior
 *      (/qr, /status, /connect, /disconnect, /logout, /send-message,
 *      /send-message-get), para que los sistemas que ya las consumen no cambien
 *      nada. Todas aceptan ahora un parámetro OPCIONAL `session` (body o query);
 *      si no se envía, operan sobre la sesión por defecto (compat total).
 *   B) Web UI en '/' — página para gestionar varias sesiones (QR, estado, envío).
 *
 * MULTI-SESIÓN: además de la fachada, expone GET /sessions (listar con estado) y
 * POST /sessions (crear/arrancar una sesión). El resto de rutas elige la sesión
 * con el parámetro `session`. Así un mismo servidor maneja varios números a la vez
 * y cada consumidor (p.ej. cada tienda del APK) indica de qué sesión salen sus
 * mensajes.
 *
 * AUTH OBLIGATORIA (iteración 1.2): TODA ruta de API exige cookie de admin
 * (obtenida con POST /login) o el token vigente en `X-Api-Key`/?apikey=. Sin
 * credencial responde 401 { error: 'login_requerido' } con un mensaje que pide
 * actualizarse porque ahora se necesita iniciar sesión para enviar mensajes.
 * Credenciales y token viven en ./data/auth.json (ver ./auth.js); el token se
 * siembra desde FACADE_API_KEY en el primer arranque para no romper a los
 * consumidores existentes. La web UI estática en '/' queda pública (su JS hace
 * login y usa la cookie). WAHA_API_KEY sigue siendo el secreto interno
 * motor↔fachada, distinto de todo esto.
 *
 * No habla con WhatsApp directamente: todo pasa por ./wahaClient.js. Al arrancar
 * engancha la sesión por defecto (con reintentos) para reconectar sola tras un
 * `docker compose up` si ya estaba guardada en el volumen persistente.
 *
 * Config por entorno: PORT (default 80), AUTH_DIR / ADMIN_USER / ADMIN_PASS /
 * FACADE_API_KEY (solo siembran el primer arranque; ver auth.js) + las de
 * wahaClient.js (WAHA_URL, WAHA_SESSION, WAHA_API_KEY). Requiere Node 18+.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const waha = require('./wahaClient');
const auth = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Normaliza un número a chatId de WhatsApp: solo dígitos + sufijo @c.us.
function toChatId(number) {
  return `${String(number).replace(/[^0-9]/g, '')}@c.us`;
}

// Sesión pedida por el consumidor (body o query); undefined -> sesión por defecto.
function getSession(req) {
  return (req.body && req.body.session) || req.query.session || undefined;
}

// ---------------------------------------------------------------------------
// Web UI (estática, pública) — su JS adjunta la X-Api-Key si la auth está activa.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Autenticación (OBLIGATORIA). Rutas públicas: la UI estática, /login,
// /change-password (valida la contraseña actual por sí misma) y /logout-admin.
// Todo lo demás exige cookie de admin o X-Api-Key con el token vigente.
// ---------------------------------------------------------------------------
const COOKIE_NAME = 'wa_admin';
const MENSAJE_401 =
  'La API de WhatsApp ahora requiere iniciar sesión para enviar mensajes. ' +
  'Debe actualizar su aplicación o configurar usuario y contraseña para continuar.';

// Lee el sid de la cookie wa_admin sin depender de cookie-parser.
function sidFrom(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return m ? m[1] : '';
}

// Login de admin: emite el token de API + cookie de sesión para el panel.
app.post('/login', (req, res) => {
  const { user, pass } = req.body || {};
  const r = auth.login(String(user || ''), String(pass || ''));
  if (!r.ok) return res.status(401).json({ ok: false, error: 'usuario o contraseña incorrectos' });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${r.sid}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
  res.json({ ok: true, token: r.token });
});

// Cambio de contraseña (valida la actual; lo usa TIENDA para mantenerse en sync).
app.post('/change-password', (req, res) => {
  const { user, passActual, passNueva } = req.body || {};
  const r = auth.changePassword(String(user || ''), String(passActual || ''), String(passNueva || ''));
  if (!r.ok) return res.status(401).json(r);
  res.json(r);
});

// Cierra la sesión de cookie del panel.
app.post('/logout-admin', (req, res) => {
  auth.logoutSid(sidFrom(req));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (auth.isAdminSid(sidFrom(req))) return next();
  const provided = req.get('X-Api-Key') || req.query.apikey;
  if (provided && provided === auth.getToken()) return next();
  return res.status(401).json({ error: 'login_requerido', message: MENSAJE_401 });
}
app.use(requireAuth);

// Token vigente (para mostrarlo en el panel) y rotación.
app.get('/token', (req, res) => res.json({ token: auth.getToken() }));
app.post('/rotate-token', (req, res) => res.json({ ok: true, token: auth.rotateToken() }));

// ---------------------------------------------------------------------------
// Gestión de sesiones (multi-número)
// ---------------------------------------------------------------------------

// Listar sesiones con su estado -> { sessions: [{ name, status }] }.
app.get('/sessions', async (req, res) => {
  try {
    res.json({ sessions: await waha.listSessions() });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Crear/arrancar una sesión -> { ok, name }. Idempotente (si ya existe, la arranca).
app.post('/sessions', async (req, res) => {
  const name = (req.body && req.body.name) || '';
  if (!name) return res.status(400).json({ error: 'name es requerido' });
  try {
    await waha.ensureStarted(name);
    res.json({ ok: true, name });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Fachada legacy (contrato idéntico; `session` opcional)
// ---------------------------------------------------------------------------

// Estado del cliente -> { ready }
app.get('/status', async (req, res) => {
  try {
    res.json({ ready: await waha.isReady(getSession(req)) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// QR como dataURL -> { qr }. 404 si no hay QR (ya conectado o sin arrancar).
app.get('/qr', async (req, res) => {
  try {
    const session = getSession(req);
    if (await waha.isReady(session)) return res.status(404).json({ error: 'QR no disponible' });
    const qr = await waha.getQrDataUrl(session);
    if (!qr) return res.status(404).json({ error: 'QR no disponible' });
    res.json({ qr });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Forzar (re)conexión / generar QR.
app.post('/connect', async (req, res) => {
  try {
    await waha.ensureStarted(getSession(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Detener la sesión (conserva la autenticación).
app.post('/disconnect', async (req, res) => {
  try {
    await waha.stop(getSession(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Cerrar sesión de verdad (borra auth, fuerza nuevo QR). Usado por la web UI.
app.post('/logout', async (req, res) => {
  try {
    await waha.logout(getSession(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Enviar mensaje (texto y opcional archivo) vía multipart/form-data.
app.post('/send-message', upload.single('file'), async (req, res) => {
  const { number, message } = req.body;
  const session = getSession(req);
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !req.file) return res.status(400).json({ error: 'message o file es requerido' });

  try {
    if (!(await waha.isReady(session))) {
      return res.status(409).json({ error: 'WhatsApp no está conectado' });
    }
    const chatId = toChatId(number);
    let id;
    if (req.file) {
      id = await waha.sendMedia(
        session,
        chatId,
        {
          mimetype: req.file.mimetype,
          filename: req.file.originalname,
          data: req.file.buffer.toString('base64'),
        },
        message
      );
    } else {
      id = await waha.sendText(session, chatId, message);
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('send error', err);
    res.status(500).json({ error: String(err) });
  }
});

// Enviar mensaje vía GET (params: number, message, file base64, fileName, fileType, session).
app.get('/send-message-get', async (req, res) => {
  const { number, message, file, fileName, fileType } = req.query;
  const session = getSession(req);
  if (!number) return res.status(400).json({ error: 'number es requerido' });
  if (!message && !file) return res.status(400).json({ error: 'message o file es requerido' });

  try {
    if (!(await waha.isReady(session))) {
      return res.status(409).json({ error: 'WhatsApp no está conectado' });
    }
    const chatId = toChatId(number);
    let id;
    if (file) {
      id = await waha.sendMedia(
        session,
        chatId,
        { mimetype: fileType || 'application/octet-stream', filename: fileName || 'file', data: file },
        message
      );
    } else {
      id = await waha.sendText(session, chatId, message);
    }
    res.json({ ok: true, id });
  } catch (err) {
    console.error('send error (GET)', err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Arranque + enganche de la sesión por defecto de WAHA con reintentos
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
