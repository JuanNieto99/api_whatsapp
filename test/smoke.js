/**
 * test/smoke.js — smoke test de la fachada legacy contra un WAHA simulado.
 *
 * Levanta un mock HTTP que imita los endpoints de WAHA, arranca server.js
 * apuntándolo a ese mock, y verifica el contrato de las rutas legacy sin
 * necesidad de WhatsApp real: /status, /qr, /send-message (texto y media),
 * /send-message-get, el guard 409 cuando no está conectado y la normalización
 * del número a chatId.
 *
 * Uso: node test/smoke.js   (sin dependencias; requiere Node 18+)
 * Sale con código 0 si todo pasa, 1 si algo falla.
 */

const http = require('http');
const assert = require('assert');

let sessionStatus = 'WORKING'; // el mock lo puede cambiar entre casos
const received = []; // registro de requests que llegaron al mock

// --- Mock de WAHA ---------------------------------------------------------
const waha = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    received.push({ method: req.method, url, body: body ? JSON.parse(body) : null });
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && url === '/api/sessions/default') return json(200, { status: sessionStatus });
    if (req.method === 'GET' && url === '/api/default/auth/qr') return json(200, { mimetype: 'image/png', data: 'QRBASE64==' });
    if (req.method === 'POST' && url === '/api/sessions') return json(201, { name: 'default', status: 'STARTING' });
    if (req.method === 'POST' && url === '/api/sessions/default/start') return json(200, { ok: true });
    if (req.method === 'POST' && url === '/api/sessions/default/stop') return json(200, { ok: true });
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

  // Caso A — sesión WORKING
  sessionStatus = 'WORKING';

  await check('/status devuelve { ready: true }', async () => {
    const j = await (await fetch(`${base}/status`)).json();
    assert.deepStrictEqual(j, { ready: true });
  });

  await check('/qr devuelve 404 cuando ya está conectado', async () => {
    const r = await fetch(`${base}/qr`);
    assert.strictEqual(r.status, 404);
  });

  await check('/send-message (texto) -> sendText con chatId normalizado', async () => {
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

  await check('/send-message-get (texto) -> sendText', async () => {
    const r = await fetch(`${base}/send-message-get?number=573009999999&message=ping`);
    const j = await r.json();
    assert.strictEqual(j.id, 'txt_1');
    assert.strictEqual(lastTo('/api/sendText').body.chatId, '573009999999@c.us');
  });

  await check('/send-message-get (file base64) -> sendFile', async () => {
    const data = Buffer.from('PDFDATA').toString('base64');
    const url = `${base}/send-message-get?number=573001112222&file=${data}&fileType=application/pdf&fileName=x.pdf`;
    const j = await (await fetch(url)).json();
    assert.strictEqual(j.id, 'file_1');
    assert.strictEqual(lastTo('/api/sendFile').body.file.filename, 'x.pdf');
  });

  // Caso B — sesión NO conectada
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
