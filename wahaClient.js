/**
 * wahaClient.js — cliente HTTP fino contra el motor WAHA (WhatsApp HTTP API).
 *
 * Rol: única capa que conoce la forma de la API de WAHA. El resto de la app
 * (server.js) habla WhatsApp exclusivamente a través de estas funciones, de modo
 * que si WAHA cambia endpoints, se toca solo este archivo.
 *
 * Uso típico:
 *   const waha = require('./wahaClient');
 *   await waha.ensureStarted();                 // arranca/reengancha la sesión
 *   const st = await waha.getStatus();          // 'WORKING' | 'SCAN_QR_CODE' | ...
 *   const qr = await waha.getQrDataUrl();       // dataURL PNG o null si no aplica
 *   await waha.sendText('549...@c.us', 'Hola');
 *
 * Config por entorno (con defaults para desarrollo):
 *   WAHA_URL      URL interna del motor (ej. http://waha:3000)
 *   WAHA_SESSION  nombre de la sesión (ej. default)
 *   WAHA_API_KEY  secreto; se envía en el header X-Api-Key
 *
 * Notas de diseño:
 *  - Engine NOWEB (sin Chromium): evita la clase de fallos de puppeteer.
 *  - Requiere Node 18+ (usa fetch global).
 *  - Todas las funciones lanzan Error con mensaje legible ante fallos del motor;
 *    getStatus() y getQrDataUrl() devuelven valores "vacíos" (null) en los casos
 *    esperados (sesión inexistente / sin QR) en vez de lanzar.
 */

const WAHA_URL = (process.env.WAHA_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SESSION = process.env.WAHA_SESSION || 'default';
const API_KEY = process.env.WAHA_API_KEY || '';

// Llama a la API de WAHA agregando base URL y API key. Devuelve el Response.
async function wahaFetch(path, options = {}) {
  const headers = Object.assign(
    { 'X-Api-Key': API_KEY },
    options.body ? { 'Content-Type': 'application/json' } : {},
    options.headers || {}
  );
  return fetch(`${WAHA_URL}${path}`, { ...options, headers });
}

// Estado de la sesión: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' |
// 'STOPPED' | 'PASSKEY_REQUIRED' | ... ; null si la sesión aún no existe.
async function getStatus() {
  const res = await wahaFetch(`/api/sessions/${SESSION}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WAHA getStatus ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.status || null;
}

// ¿La sesión está lista para enviar?
async function isReady() {
  return (await getStatus()) === 'WORKING';
}

// Crea la sesión si no existe y la arranca; idempotente. Se llama al boot y en /connect.
async function ensureStarted() {
  const status = await getStatus();
  if (status === null) {
    const res = await wahaFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: SESSION, start: true }),
    });
    // 201/200 = creada; 422/409 = ya existía (carrera): caemos a start explícito.
    if (!res.ok && res.status !== 422 && res.status !== 409) {
      throw new Error(`WAHA create session ${res.status}: ${await res.text()}`);
    }
    if (res.status === 422 || res.status === 409) await startExisting();
    return;
  }
  if (status === 'STOPPED' || status === 'FAILED') await startExisting();
}

async function startExisting() {
  const res = await wahaFetch(`/api/sessions/${SESSION}/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`WAHA start ${res.status}: ${await res.text()}`);
}

// Detiene la sesión conservando la autenticación (mapea el /disconnect legacy).
async function stop() {
  const res = await wahaFetch(`/api/sessions/${SESSION}/stop`, { method: 'POST' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`WAHA stop ${res.status}: ${await res.text()}`);
  }
}

// Cierra sesión de verdad: borra la autenticación y fuerza re-escaneo de QR.
async function logout() {
  const res = await wahaFetch(`/api/sessions/${SESSION}/logout`, { method: 'POST' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`WAHA logout ${res.status}: ${await res.text()}`);
  }
}

// QR como dataURL (data:image/png;base64,...). Devuelve null si no hay QR
// disponible (p.ej. la sesión ya está WORKING o aún no arrancó).
async function getQrDataUrl() {
  const res = await wahaFetch(`/api/${SESSION}/auth/qr`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.data) return null;
  const mimetype = data.mimetype || 'image/png';
  return `data:${mimetype};base64,${data.data}`;
}

// Normaliza el id de mensaje que devuelve WAHA a un string (forma dependiente del engine).
function extractId(resp) {
  if (!resp) return null;
  return (
    (resp.id && resp.id._serialized) ||
    (typeof resp.id === 'string' ? resp.id : null) ||
    (resp.key && resp.key.id) ||
    null
  );
}

// Envía texto. chatId con formato '<digitos>@c.us'. Devuelve el id del mensaje.
async function sendText(chatId, text) {
  const res = await wahaFetch('/api/sendText', {
    method: 'POST',
    body: JSON.stringify({ session: SESSION, chatId, text }),
  });
  if (!res.ok) throw new Error(`WAHA sendText ${res.status}: ${await res.text()}`);
  return extractId(await res.json());
}

// Envía media (imagen o archivo) desde base64. Elige sendImage/sendFile por mimetype.
async function sendMedia(chatId, { mimetype, filename, data }, caption) {
  const isImage = (mimetype || '').startsWith('image/');
  const endpoint = isImage ? '/api/sendImage' : '/api/sendFile';
  const body = {
    session: SESSION,
    chatId,
    file: { mimetype: mimetype || 'application/octet-stream', filename: filename || 'file', data },
  };
  if (caption) body.caption = caption;
  const res = await wahaFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`WAHA sendMedia ${res.status}: ${await res.text()}`);
  return extractId(await res.json());
}

module.exports = {
  SESSION,
  getStatus,
  isReady,
  ensureStarted,
  stop,
  logout,
  getQrDataUrl,
  sendText,
  sendMedia,
};
