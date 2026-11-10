/**
 * test/auth.js — tests del módulo auth.js (sin red, sin WhatsApp).
 *
 * Verifica: siembra del primer arranque (defaults y desde env), login y emisión
 * de token, cambio de contraseña persistido en data/auth.json, rotación de token
 * y sesiones de cookie (sid) en memoria.
 *
 * Uso: node test/auth.js   (sin dependencias extra; requiere Node 18+)
 * Sale con código 0 si todo pasa, 1 si algo falla.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.error('  ✗', name, '\n    ', e.message); }
}

// Carga una instancia LIMPIA del módulo contra un AUTH_DIR temporal nuevo.
function freshAuth(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));
  process.env.AUTH_DIR = dir;
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  delete process.env.FACADE_API_KEY;
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../auth')];
  return { auth: require('../auth'), dir };
}

// Re-carga el módulo sobre el MISMO dir (simula reinicio del proceso).
function reload(dir) {
  process.env.AUTH_DIR = dir;
  delete require.cache[require.resolve('../auth')];
  return require('../auth');
}

check('siembra con defaults: login admin/kjQ7rYIxFTkABbbpCjfW ok y entrega token', () => {
  const { auth } = freshAuth();
  const r = auth.login('admin', 'kjQ7rYIxFTkABbbpCjfW');
  assert.strictEqual(r.ok, true);
  assert.ok(r.token && r.token.length >= 16);
  assert.ok(r.sid && r.sid.length >= 16);
  assert.strictEqual(r.token, auth.getToken());
});

check('siembra desde env: ADMIN_USER/ADMIN_PASS y token = FACADE_API_KEY', () => {
  const { auth } = freshAuth({ ADMIN_USER: 'juan', ADMIN_PASS: 'clave-propia', FACADE_API_KEY: 'token-legacy-123' });
  assert.strictEqual(auth.getToken(), 'token-legacy-123');
  assert.strictEqual(auth.login('juan', 'clave-propia').ok, true);
  assert.strictEqual(auth.login('admin', 'kjQ7rYIxFTkABbbpCjfW').ok, false);
});

check('login con contraseña mala o usuario malo falla sin token', () => {
  const { auth } = freshAuth();
  assert.strictEqual(auth.login('admin', 'mala').ok, false);
  assert.strictEqual(auth.login('otro', 'kjQ7rYIxFTkABbbpCjfW').ok, false);
  assert.strictEqual(auth.login('admin', 'mala').token, undefined);
});

check('changePassword valida la actual, persiste y invalida la vieja', () => {
  const { auth, dir } = freshAuth();
  assert.strictEqual(auth.changePassword('admin', 'mala', 'nueva123').ok, false);
  assert.strictEqual(auth.changePassword('admin', 'kjQ7rYIxFTkABbbpCjfW', 'nueva123').ok, true);
  assert.strictEqual(auth.login('admin', 'kjQ7rYIxFTkABbbpCjfW').ok, false);
  assert.strictEqual(auth.login('admin', 'nueva123').ok, true);
  // Reinicio del proceso: la nueva contraseña quedó en data/auth.json
  const auth2 = reload(dir);
  assert.strictEqual(auth2.login('admin', 'nueva123').ok, true);
});

check('rotateToken cambia el token, lo persiste y getToken lo refleja', () => {
  const { auth, dir } = freshAuth();
  const t1 = auth.getToken();
  const t2 = auth.rotateToken();
  assert.notStrictEqual(t1, t2);
  assert.strictEqual(auth.getToken(), t2);
  assert.strictEqual(reload(dir).getToken(), t2);
});

check('isAdminSid: true tras login, false para sid inventado, false tras logoutSid', () => {
  const { auth } = freshAuth();
  const { sid } = auth.login('admin', 'kjQ7rYIxFTkABbbpCjfW');
  assert.strictEqual(auth.isAdminSid(sid), true);
  assert.strictEqual(auth.isAdminSid('x'.repeat(48)), false);
  auth.logoutSid(sid);
  assert.strictEqual(auth.isAdminSid(sid), false);
});

if (failures) { console.error(`\n${failures} test(s) fallaron`); process.exit(1); }
console.log('\nauth.js: todos los tests pasaron');
