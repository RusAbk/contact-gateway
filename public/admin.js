const loginPanel = document.getElementById('login-panel');
const adminContent = document.getElementById('admin-content');
const logoutButton = document.getElementById('logout-button');
let loggedIn = false;

async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('No hay conexión con el servidor. Inténtalo de nuevo.'); }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = new Error(result?.error ?? 'No se pudo completar la solicitud.');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function post(path, payload = {}) { return request(path, { method: 'POST', body: JSON.stringify(payload) }); }

function setLoggedIn(value) {
  loggedIn = value;
  loginPanel.classList.toggle('hidden', value);
  adminContent.classList.toggle('hidden', !value);
  logoutButton.classList.toggle('hidden', !value);
}

async function updateStatus() {
  if (!loggedIn) return;
  try {
    const status = await request('/api/admin/status');
    const labels = { starting: 'Iniciando', connecting: 'Conectando', pairing: 'Esperando el escaneo', connected: 'Conectado', reconnecting: 'Reconectando', logged_out: 'Desconectado' };
    document.getElementById('wa-status').textContent = labels[status.state] ?? status.state;
    document.getElementById('connection-note').textContent = status.state === 'connected' ? `Cuenta conectada${status.connectedAs ? `: ${status.connectedAs}` : ''}. Los mensajes nuevos aparecerán en la lista de chats.` : status.state === 'pairing' ? 'Escanea el código QR con tu teléfono. Desaparecerá cuando se vincule la cuenta.' : 'Si no se restablece la conexión, pulsa «Actualizar conexión».';
    document.getElementById('pairing-panel').classList.toggle('hidden', !status.pairingQr);
    if (status.pairingQr) document.getElementById('pairing-qr').src = status.pairingQr;
    const numberInput = document.getElementById('public-number-input');
    if (document.activeElement !== numberInput) numberInput.value = status.number ?? '';
    await updatePublicQr();
  } catch (error) { if (error.status === 401) setLoggedIn(false); }
}

async function updatePublicQr() {
  const result = await request('/api/whatsapp');
  const ready = document.getElementById('public-qr-panel');
  const empty = document.getElementById('public-qr-empty');
  ready.classList.toggle('hidden', !result.available);
  empty.classList.toggle('hidden', result.available);
  if (result.available) { document.getElementById('public-qr').src = result.qr; document.getElementById('public-number').textContent = `+${result.number}`; }
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter ?? event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  const message = document.getElementById('login-message');
  message.textContent = '';
  try { await post('/api/admin/login', { password: document.getElementById('password').value }); setLoggedIn(true); document.getElementById('password').value = ''; await updateStatus(); }
  catch (error) { message.textContent = error.message; message.className = 'message error'; }
  finally { button.disabled = false; }
});

logoutButton.addEventListener('click', async () => { try { await post('/api/admin/logout'); } finally { setLoggedIn(false); } });
document.getElementById('reconnect-button').addEventListener('click', async () => { await post('/api/admin/whatsapp/reconnect').catch((error) => { document.getElementById('connection-note').textContent = error.message; }); await updateStatus(); });
document.getElementById('wa-logout-button').addEventListener('click', async () => { if (!confirm('¿Desvincular WhatsApp Web? Los visitantes no verán el código QR hasta que vuelvas a conectarlo.')) return; await post('/api/admin/whatsapp/logout'); await updateStatus(); });
document.getElementById('number-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.getElementById('number-message');
  try { await post('/api/admin/number', { number: document.getElementById('public-number-input').value }); message.textContent = 'Número guardado.'; message.className = 'message success'; await updatePublicQr(); }
  catch (error) { message.textContent = error.message; message.className = 'message error'; }
});
request('/api/admin/session').then(async () => { setLoggedIn(true); await updateStatus(); }).catch(() => setLoggedIn(false));
setInterval(() => { if (loggedIn && !document.hidden) void updateStatus(); }, 4_000);
