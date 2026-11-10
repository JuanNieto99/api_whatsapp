/**
 * auth.js — autenticación de la fachada: credenciales de admin + token de API.
 *
 * Rol: guarda en disco (AUTH_DIR/auth.json, por defecto ./data/auth.json) el
 * usuario admin, el hash de su contraseña (scrypt) y el TOKEN de API vigente.
 * Expone login (emite token + sid de cookie), cambio de contraseña, rotación
 * de token y validación de sesiones de panel (sids en memoria, TTL 12 h).
 *
 * Siembra del PRIMER arranque (solo si auth.json no existe):
 *   - usuario   = env ADMIN_USER  || 'admin'
 *   - contraseña= env ADMIN_PASS  || default del equipo (ver abajo)
 *   - token     = env FACADE_API_KEY || aleatorio — sembrar desde FACADE_API_KEY
 *     permite encender la auth obligatoria SIN romper a los consumidores que ya
 *     mandaban esa key (TIENDA web, APK).
 * Después del primer arranque manda el archivo: cambiar las env no re-siembra.
 *
 * Uso típico (server.js):
 *   const auth = require('./auth');
 *   auth.login(user, pass)                 -> { ok, token, sid } | { ok:false }
 *   auth.changePassword(u, actual, nueva)  -> { ok } | { ok:false, error }
 *   auth.rotateToken()                     -> token nuevo
 *   auth.getToken() / auth.isAdminSid(sid) / auth.logoutSid(sid)
 *
 * Nota: las sesiones de cookie viven en memoria — un reinicio obliga a re-login
 * del panel (los consumidores por token no se ven afectados).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'kjQ7rYIxFTkABbbpCjfW'; // default del equipo (decisión 2026-11-06)
const SID_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas de sesión de panel

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'data');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

// sid -> timestamp de expiración (en memoria)
const sessions = new Map();

function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 64).toString('hex');
}

function save(data) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function load() {
  if (!fs.existsSync(AUTH_FILE)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const seeded = {
      user: process.env.ADMIN_USER || DEFAULT_USER,
      salt,
      passHash: hashPass(process.env.ADMIN_PASS || DEFAULT_PASS, salt),
      token: process.env.FACADE_API_KEY || crypto.randomBytes(24).toString('hex'),
    };
    save(seeded);
    return seeded;
  }
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

function credsOk(data, user, pass) {
  if (user !== data.user) return false;
  const given = Buffer.from(hashPass(pass, data.salt), 'hex');
  const stored = Buffer.from(data.passHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

function login(user, pass) {
  const data = load();
  if (!credsOk(data, user, pass)) return { ok: false };
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, Date.now() + SID_TTL_MS);
  return { ok: true, token: data.token, sid };
}

function changePassword(user, passActual, passNueva) {
  const data = load();
  if (!credsOk(data, user, passActual)) return { ok: false, error: 'usuario o contraseña actual incorrectos' };
  if (!passNueva || String(passNueva).length < 8) return { ok: false, error: 'la contraseña nueva debe tener al menos 8 caracteres' };
  data.salt = crypto.randomBytes(16).toString('hex');
  data.passHash = hashPass(passNueva, data.salt);
  save(data);
  return { ok: true };
}

function rotateToken() {
  const data = load();
  data.token = crypto.randomBytes(24).toString('hex');
  save(data);
  return data.token;
}

function getToken() {
  return load().token;
}

function isAdminSid(sid) {
  const exp = sid && sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}

function logoutSid(sid) {
  sessions.delete(sid);
}

module.exports = { login, changePassword, rotateToken, getToken, isAdminSid, logoutSid };
