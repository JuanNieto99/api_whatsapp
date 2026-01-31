async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  try { return await res.json(); } catch (e) { return null; }
}

// SweetAlert2 toast helper
function toast(type, title) {
  if (window.Swal) {
    return Swal.fire({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, icon: type, title });
  } else { console[type === 'error' ? 'error' : 'log'](title); }
}

async function loadQr() {
  const img = document.getElementById('qr-img');
  try {
    const data = await api('/qr');
    img.src = data.qr;
    document.getElementById('qr-placeholder').style.display = 'none';
  } catch (e) {
    img.src = '';
    document.getElementById('qr-placeholder').style.display = 'block';
    console.warn('QR no disponible', e);
  }
}

async function loadSessions() {
  try {
    const data = await api('/session');
    document.getElementById('session-name').textContent = 'Sesión: ' + (data.session || '---');
    document.getElementById('client-status').textContent = 'Carpeta sessions: ' + (data.sessionsFolderExists ? 'sí' : 'no');
    // obtener estado listo
    const st = await api('/status');
    const badge = document.getElementById('ready-badge');
    if (st && st.ready) { badge.className = 'badge bg-success'; badge.textContent = 'Listo'; }
    else { badge.className = 'badge bg-secondary'; badge.textContent = 'Desconectado'; }
  } catch (e) { console.error(e); }
}

document.getElementById('refresh-qr').addEventListener('click', async () => {
  document.getElementById('qr-img').src = '';
  try { await api('/connect', { method: 'POST' }); toast('success', 'Conexión iniciada'); } catch (e) { toast('error', 'Error iniciando conexión'); }
  startQrPolling();
  setTimeout(() => stopQrPolling(), 30000);
});

document.getElementById('delete-session').addEventListener('click', async () => {
  const res = await Swal.fire({ title: 'Eliminar sesiones?', text: 'Eliminar la carpeta de sesiones y reiniciar la sesión por defecto', icon: 'warning', showCancelButton: true, confirmButtonText: 'Sí, eliminar' });
  if (!res.isConfirmed) return;
  try {
    await api('/session', { method: 'DELETE' });
    toast('success', 'Sesiones eliminadas');
    document.getElementById('qr-img').src = '';
    await loadSessions();
  } catch (e) { Swal.fire('Error', String(e), 'error'); }
});

document.getElementById('connect').addEventListener('click', async () => {
  try { await api('/connect', { method: 'POST' }); toast('success', 'Conexión solicitada'); startQrPolling(); } catch (e) { Swal.fire('Error', String(e), 'error'); }
});

document.getElementById('disconnect').addEventListener('click', async () => {
  try { await api('/disconnect', { method: 'POST' }); toast('success', 'Desconectado'); loadSessions(); } catch (e) { Swal.fire('Error', String(e), 'error'); }
});

document.getElementById('send-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  try {
    const res = await fetch('/send-message', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    toast('success', 'Mensaje enviado: ' + (data.id || 'ok'));
    document.getElementById('send-result').textContent = 'Enviado: ' + (data.id || 'ok');
    form.reset();
  } catch (e) {
    Swal.fire('Error', String(e), 'error');
  }
});

document.getElementById('load-logs').addEventListener('click', async () => {
  try {
    const r = await fetch('/logs?lines=400');
    const t = await r.text();
    document.getElementById('logs').value = t;
  } catch (e) {
    document.getElementById('logs').value = 'Error: ' + e.message;
  }
});

// Inicializar
loadSessions();
loadQr();

// Polling automático: intentar obtener QR cada 5s si no hay uno disponible
let qrPollInterval = null;
function startQrPolling() {
  if (qrPollInterval) return;
  qrPollInterval = setInterval(async () => {
    try {
      await loadQr();
    } catch (e) {
      // ignore
    }
  }, 5000);
}

function stopQrPolling() {
  if (!qrPollInterval) return;
  clearInterval(qrPollInterval);
  qrPollInterval = null;
}

// Al presionar refrescar, pedir al servidor que (re)inicialice la sesión y
// luego hacer polling del QR hasta que aparezca o expire (30s)
document.getElementById('refresh-qr').addEventListener('click', async () => {
  const img = document.getElementById('qr-img');
  img.src = '';
  try {
    await api('/connect', { method: 'POST' });
  } catch (e) {
    console.warn('connect failed', e);
  }
  startQrPolling();
  // stop polling en 30s
  setTimeout(() => stopQrPolling(), 30000);
});

// iniciar polling para intentar mostrar QR automáticamente
startQrPolling();
