/**
 * test/smoke.js — smoke test de la fachada contra un WAHA simulado.
 *
 * Levanta un mock HTTP que imita los endpoints de WAHA (multi-sesión), arranca
 * server.js apuntándolo a ese mock, y verifica el contrato sin WhatsApp real:
 *   - Fachada legacy: /status, /qr, /send-message (texto y media),
 *     /send-message-get, guard 409 sin conexión, normalización número -> chatId.
 *   - Multi-sesión: la sesión se propaga a WAHA (default cuando no se envía,
 *     la indicada cuando sí), y GET/POST /sessions.
 *   - Auth de fachada opt-in: con FACADE_API_KEY, 401 sin key y 200 con key.
 *
 * Uso: node test/smoke.js   (sin dependencias extra; requiere Node 18+)
 * Sale con código 0 si todo pasa, 1 si algo falla.
 */

const http = require('http');
const assert = require('assert');

let sessionStatus = 'WORKING'; // el mock lo puede cambiar entre casos
const received = []; // registro de requests que llegaron al mock
const createdSessions = []; // sesiones creadas vía POST /api/sessions

// --- Mock de WAHA (multi-sesión) -----------------------------------------
const waha = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    const parsed = body ? JSON.parse(body) : null;
    received.push({ method: req.method, url, body: parsed });
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    let m;
    // Listado de sesiones
    if (req.method === 'GET' && url === '/api/sessions') {
      return json(200, [{ name: 'default', status: sessionStatus }, ...createdSessions]);
    }
    // Crear sesión
    if (req.method === 'POST' && url === '/api/sessions') {
      createdSessions.push({ name: parsed && parsed.name, status: 'STARTING' });
      return json(201, { name: parsed && parsed.name, status: 'STARTING' });
    }
    // Estado de una sesión concreta (cualquier nombre)
    if (req.method === 'GET' && (m = url.match(/^\/api\/sessions\/([^/]+)$/))) {
      return json(200, { name: m[1], status: sessionStatus });
    }
    // start/stop/logout de una sesión concreta
    if (req.method === 'POST' && (m = url.match(/^\/api\/sessions\/([^/]+)\/(start|stop|logout)$/))) {
      return json(200, { ok: true });
    }
    // QR de una sesión concreta
    if (req.method === 'GET' && (m = url.match(/^\/api\/([^/]+)\/auth\/qr$/))) {
      return json(200, { mimetype: 'image/png', data: 'QRBASE64==' });
    }
    // Envíos
    if (req.method === 'POST' && url === '/api/sendText') return json(201, { id: { _serialized: 'txt_1' } });
    if (req.method === 'POST' && url === '/api/sendImage') return json(201, { id: 'img_1' });
    if (req.method === 'POST' && url === '/api/sendFile') return json(201, { id: 'file_1' });
    json(404, { error: 'not found' });
  });
});

const API_PORT = 8099;
const WAHA_PORT = 8098;
const base = `http://localhost:${API_PORT}`;

function lastTo(url) { return [...received].reverse().find((r) => r.url === url); }

async function run() {
  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.error('  ✗', name, '\n    ', e.message); }
  };

  // ---- Caso A — sesión WORKING, auth desactivada --------------------------
  sessionStatus = 'WORKING';
  delete process.env.FACADE_API_KEY;

  await check('/status devuelve { ready: true }', async () => {
    const j = await (await fetch(`${base}/status`)).json();
    assert.deepStrictEqual(j, { ready: true });
  });

  await check('/qr devuelve 404 cuando ya está conectado', async () => {
    const r = await fetch(`${base}/qr`);
    assert.strictEqual(r.status, 404);
  });

  await check('/send-message (texto, sin session) -> sendText con chatId y session=default', async () => {
    const fd = new FormData();
    fd.append('number', '+57 (300) 123-4567');
    fd.append('message', 'hola');
    const r = await fetch(`${base}/send-message`, { method: 'POST', body: fd });
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.id, 'txt_1');
    const sent = lastTo('/api/sendText');
    assert.strictEqual(sent.body.chatId, '573001234567@c.us');
    assert.strictEqual(sent.body.text, 'hola');
    assert.strictEqual(sent.body.session, 'default'); // compat: cae en la sesión por defecto
  });

  await check('/send-message con session explícita -> propaga esa sesión a WAHA', async () => {
    const fd = new FormData();
    fd.append('number', '573001234567');
    fd.append('message', 'multi');
    fd.append('session', 'tienda1');
    const r = await fetch(`${base}/send-message`, { method: 'POST', body: fd });
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(lastTo('/api/sendText').body.session, 'tienda1');
  });

  await check('/send-message (imagen) -> sendImage con base64 y caption', async () => {
    const fd = new FormData();
    fd.append('number', '573001234567');
    fd.append('message', 'foto');
    fd.append('file', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'p.png');
    const r = await fetch(`${base}/send-message`, { method: 'POST', body: fd });
    const j = await r.json();
    assert.strictEqual(j.id, 'img_1');
    const sent = lastTo('/api/sendImage');
    assert.strictEqual(sent.body.caption, 'foto');
    assert.strictEqual(sent.body.file.data, Buffer.from('PNGDATA').toString('base64'));
  });

  await check('/send-message-get (texto, con session) -> sendText', async () => {
    const r = await fetch(`${base}/send-message-get?number=573009999999&message=ping&session=tienda2`);
    const j = await r.json();
    assert.strictEqual(j.id, 'txt_1');
    const sent = lastTo('/api/sendText');
    assert.strictEqual(sent.body.chatId, '573009999999@c.us');
    assert.strictEqual(sent.body.session, 'tienda2');
  });

  await check('/send-message-get (file base64) -> sendFile', async () => {
    const data = Buffer.from('PDFDATA').toString('base64');
    const url = `${base}/send-message-get?number=573001112222&file=${data}&fileType=application/pdf&fileName=x.pdf`;
    const j = await (await fetch(url)).json();
    assert.strictEqual(j.id, 'file_1');
    assert.strictEqual(lastTo('/api/sendFile').body.file.filename, 'x.pdf');
  });

  // ---- Multi-sesión: gestión ----------------------------------------------
  await check('GET /sessions -> lista con estado', async () => {
    const j = await (await fetch(`${base}/sessions`)).json();
    assert.ok(Array.isArray(j.sessions));
    assert.ok(j.sessions.some((s) => s.name === 'default'));
  });

  await check('POST /sessions { name } -> { ok, name }', async () => {
    const r = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tienda3' }),
    });
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.name, 'tienda3');
  });

  await check('POST /sessions sin name -> 400', async () => {
    const r = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(r.status, 400);
  });

  // ---- Caso B — sesión NO conectada ---------------------------------------
  sessionStatus = 'SCAN_QR_CODE';

  await check('/status devuelve { ready: false }', async () => {
    const j = await (await fetch(`${base}/status`)).json();
    assert.deepStrictEqual(j, { ready: false });
  });

  await check('/qr devuelve el dataURL cuando NO está conectado', async () => {
    const j = await (await fetch(`${base}/qr`)).json();
    assert.strictEqual(j.qr, 'data:image/png;base64,QRBASE64==');
  });

  await check('/send-message responde 409 cuando no está conectado', async () => {
    const fd = new FormData();
    fd.append('number', '573001234567');
    fd.append('message', 'hola');
    const r = await fetch(`${base}/send-message`, { method: 'POST', body: fd });
    assert.strictEqual(r.status, 409);
  });

  await check('/send-message-get responde 409 cuando no está conectado', async () => {
    const r = await fetch(`${base}/send-message-get?number=573001234567&message=hola`);
    assert.strictEqual(r.status, 409);
  });

  // ---- Caso C — auth de fachada (opt-in) ----------------------------------
  sessionStatus = 'WORKING';
  process.env.FACADE_API_KEY = 'secreto123';

  await check('con FACADE_API_KEY, /status sin key -> 401', async () => {
    const r = await fetch(`${base}/status`);
    assert.strictEqual(r.status, 401);
  });

  await check('con FACADE_API_KEY, /status con X-Api-Key correcta -> 200', async () => {
    const r = await fetch(`${base}/status`, { headers: { 'X-Api-Key': 'secreto123' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ready: true });
  });

  await check('con FACADE_API_KEY, /status con key equivocada -> 401', async () => {
    const r = await fetch(`${base}/status`, { headers: { 'X-Api-Key': 'otra' } });
    assert.strictEqual(r.status, 401);
  });

  await check('con FACADE_API_KEY, /send-message con key -> 200', async () => {
    const fd = new FormData();
    fd.append('number', '573001234567');
    fd.append('message', 'auth ok');
    const r = await fetch(`${base}/send-message`, { method: 'POST', headers: { 'X-Api-Key': 'secreto123' }, body: fd });
    assert.strictEqual(r.status, 200);
  });

  delete process.env.FACADE_API_KEY; // restaurar modo abierto

  console.log(failures === 0 ? '\nTODO OK ✅' : `\nFALLARON ${failures} test(s) ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

waha.listen(WAHA_PORT, () => {
  process.env.WAHA_URL = `http://localhost:${WAHA_PORT}`;
  process.env.WAHA_SESSION = 'default';
  process.env.WAHA_API_KEY = 'test';
  process.env.PORT = String(API_PORT);
  require('../server.js'); // arranca Express en API_PORT
  setTimeout(run, 600); // dar tiempo al listen + bootstrap
});
