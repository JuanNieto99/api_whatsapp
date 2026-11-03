/**
 * wahaClient.js — cliente HTTP fino contra el motor WAHA (WhatsApp HTTP API).
 *
 * Rol: única capa que conoce la forma de la API de WAHA. El resto de la app
 * (server.js) habla WhatsApp exclusivamente a través de estas funciones, de modo
 * que si WAHA cambia endpoints, se toca solo este archivo.
 *
 * MULTI-SESIÓN: todas las funciones de sesión/envío reciben el nombre de la
 * sesión como primer argumento (una sesión = un número de WhatsApp vinculado).
 * Si se omite (null/''), se usa DEFAULT_SESSION (env WAHA_SESSION, o 'default').
 * Esto preserva el contrato legacy de un solo número: los consumidores viejos que
 * no mandan `session` siguen cayendo en la sesión por defecto. WAHA soporta varias
 * sesiones simultáneas de forma nativa; esta capa solo elige a cuál apuntar.
 *
 * Uso típico:
 *   const waha = require('./wahaClient');
 *   await waha.ensureStarted('tienda1');            // arranca/reengancha la sesión
 *   const st  = await waha.getStatus('tienda1');    // 'WORKING' | 'SCAN_QR_CODE' | ...
 *   const qr  = await waha.getQrDataUrl('tienda1');  // dataURL PNG o null si no aplica
 *   await waha.sendText('tienda1', '57...@c.us', 'Hola');
 *   const todas = await waha.listSessions();         // [{ name, status }, ...]
 *
 * Config por entorno (con defaults para desarrollo):
 *   WAHA_URL      URL interna del motor (ej. http://waha:3000)
 *   WAHA_SESSION  nombre de la sesión por defecto (ej. default)
 *   WAHA_API_KEY  secreto interno del motor; se envía en el header X-Api-Key a WAHA
 *
 * Notas de diseño:
 *  - Engine NOWEB (sin Chromium): evita la clase de fallos de puppeteer.
 *  - Requiere Node 18+ (usa fetch global).
 *  - Todas las funciones lanzan Error con mensaje legible ante fallos del motor;
 *    getStatus() y getQrDataUrl() devuelven valores "vacíos" (null) en los casos
 *    esperados (sesión inexistente / sin QR) en vez de lanzar.
 */

const WAHA_URL = (process.env.WAHA_URL || 'http://localhost:3000').replace(/\/+$/, '');
const DEFAULT_SESSION = process.env.WAHA_SESSION || 'default';
const API_KEY = process.env.WAHA_API_KEY || '';

// Resuelve y valida el nombre de sesión. Vacío/null -> DEFAULT_SESSION. Rechaza
// nombres con caracteres fuera de [A-Za-z0-9_-] para que no se puedan inyectar
// segmentos de ruta en las URLs de WAHA.
function sess(session) {
  const s = session == null || session === '' ? DEFAULT_SESSION : String(session).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error(`Nombre de sesión inválido: "${s}" (solo letras, dígitos, "_" y "-")`);
  }
  return s;
}

// Llama a la API de WAHA agregando base URL y API key. Devuelve el Response.
async function wahaFetch(path, options = {}) {
  const headers = Object.assign(
    { 'X-Api-Key': API_KEY },
    options.body ? { 'Content-Type': 'application/json' } : {},
    options.headers || {}
  );
  return fetch(`${WAHA_URL}${path}`, { ...options, headers });
}

// Estado de una sesión: 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' |
// 'STOPPED' | ... ; null si la sesión aún no existe.
async function getStatus(session) {
  const s = sess(session);
  const res = await wahaFetch(`/api/sessions/${s}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`WAHA getStatus ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.status || null;
}

// ¿La sesión está lista para enviar?
async function isReady(session) {
  return (await getStatus(session)) === 'WORKING';
}

// Lista todas las sesiones con su estado (incluye las detenidas con all=true).
// Devuelve [{ name, status }]. Usado por la UI/consumidores para elegir sesión.
async function listSessions() {
  const res = await wahaFetch('/api/sessions?all=true');
  if (!res.ok) throw new Error(`WAHA listSessions ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((x) => ({
    name: x.name,
    status: x.status || null,
  }));
}

// Crea la sesión si no existe y la arranca; idempotente. Se llama al boot, en
// /connect y al crear una sesión nueva desde la UI.
async function ensureStarted(session) {
  const s = sess(session);
  const status = await getStatus(s);
  if (status === null) {
    const res = await wahaFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: s, start: true }),
    });
    // 201/200 = creada; 422/409 = ya existía (carrera): caemos a start explícito.
    if (!res.ok && res.status !== 422 && res.status !== 409) {
      throw new Error(`WAHA create session ${res.status}: ${await res.text()}`);
    }
    if (res.status === 422 || res.status === 409) await startExisting(s);
    return;
  }
  if (status === 'STOPPED' || status === 'FAILED') await startExisting(s);
}

async function startExisting(session) {
  const s = sess(session);
  const res = await wahaFetch(`/api/sessions/${s}/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`WAHA start ${res.status}: ${await res.text()}`);
}

// Detiene la sesión conservando la autenticación (mapea el /disconnect legacy).
async function stop(session) {
  const s = sess(session);
  const res = await wahaFetch(`/api/sessions/${s}/stop`, { method: 'POST' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`WAHA stop ${res.status}: ${await res.text()}`);
  }
}

// Cierra sesión de verdad: borra la autenticación y fuerza re-escaneo de QR.
async function logout(session) {
  const s = sess(session);
  const res = await wahaFetch(`/api/sessions/${s}/logout`, { method: 'POST' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`WAHA logout ${res.status}: ${await res.text()}`);
  }
}

// QR como dataURL (data:image/png;base64,...). Devuelve null si no hay QR
// disponible (p.ej. la sesión ya está WORKING o aún no arrancó).
async function getQrDataUrl(session) {
  const s = sess(session);
  const res = await wahaFetch(`/api/${s}/auth/qr`, {
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

// Envía texto por una sesión. chatId con formato '<digitos>@c.us'. Devuelve el id.
async function sendText(session, chatId, text) {
  const s = sess(session);
  const res = await wahaFetch('/api/sendText', {
    method: 'POST',
    body: JSON.stringify({ session: s, chatId, text }),
  });
  if (!res.ok) throw new Error(`WAHA sendText ${res.status}: ${await res.text()}`);
  return extractId(await res.json());
}

// Envía media (imagen o archivo) desde base64 por una sesión. Elige sendImage/
// sendFile por mimetype.
async function sendMedia(session, chatId, { mimetype, filename, data }, caption) {
  const s = sess(session);
  const isImage = (mimetype || '').startsWith('image/');
  const endpoint = isImage ? '/api/sendImage' : '/api/sendFile';
  const body = {
    session: s,
    chatId,
    file: { mimetype: mimetype || 'application/octet-stream', filename: filename || 'file', data },
  };
  if (caption) body.caption = caption;
  const res = await wahaFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`WAHA sendMedia ${res.status}: ${await res.text()}`);
  return extractId(await res.json());
}

module.exports = {
  DEFAULT_SESSION,
  getStatus,
  isReady,
  listSessions,
  ensureStarted,
  stop,
  logout,
  getQrDataUrl,
  sendText,
  sendMedia,
};
