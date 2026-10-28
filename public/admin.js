const loginPanel = document.getElementById('login-panel');
const adminContent = document.getElementById('admin-content');
const logoutButton = document.getElementById('logout-button');
const chatList = document.getElementById('chats-list');
const chatMessage = document.getElementById('chats-message');
const dialog = document.getElementById('send-dialog');
let loggedIn = false;
let selectedChat = null;

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
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

function chatCard(chat) {
  const card = document.createElement('article');
  card.className = 'chat';
  if (chat.avatarAvailable) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.src = `/api/admin/avatar/${encodeURIComponent(chat.id)}`;
    avatar.onerror = () => { avatar.replaceWith(fallback()); };
    card.append(avatar);
  } else card.append(fallback());
  function fallback() { const avatar = document.createElement('div'); avatar.className = 'avatar-fallback'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = chat.name.slice(0, 1).toUpperCase(); return avatar; }
  const main = document.createElement('div');
  main.className = 'chat-main';
  const top = document.createElement('div'); top.className = 'chat-top';
  const name = document.createElement('strong'); name.className = 'chat-name'; name.textContent = chat.name;
  const time = document.createElement('time'); time.className = 'chat-time'; time.dateTime = new Date(chat.lastAt).toISOString(); time.textContent = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(chat.lastAt);
  top.append(name, time);
  const preview = document.createElement('p'); preview.className = 'chat-preview'; preview.textContent = chat.preview;
  const meta = document.createElement('p'); meta.className = 'chat-meta'; meta.textContent = chat.number ? `+${chat.number} · Tiene un mensaje recibido` : 'WhatsApp · Tiene un mensaje recibido';
  main.append(top, preview, meta);
  const button = document.createElement('button'); button.type = 'button'; button.textContent = chat.sent ? 'Ya enviado' : 'Seleccionar contacto'; button.disabled = chat.sent;
  button.addEventListener('click', () => { selectedChat = chat; document.getElementById('send-summary').textContent = `${chat.name}${chat.number ? ` · +${chat.number}` : ''}\nMensaje recibido: ${chat.lastIncomingPreview}${chat.avatarAvailable ? '' : '\nLa foto de perfil no está disponible; solo se enviará texto.'}`; dialog.showModal(); });
  card.append(main, button);
  return card;
}

async function refreshChats() {
  const button = document.getElementById('check-chats');
  button.disabled = true;
  chatMessage.textContent = 'Actualizando chats, nombres y fotos de perfil…';
  chatMessage.className = 'message';
  try {
    const { chats } = await request('/api/admin/chats');
    chatList.replaceChildren(...chats.map(chatCard));
    document.getElementById('chats-count').textContent = String(chats.length);
    chatMessage.textContent = chats.length ? `Actualizado a las ${new Intl.DateTimeFormat('es-ES', { timeStyle: 'short' }).format(new Date())}` : 'Todavía no hay chats con mensajes recibidos. Cuando llegue uno, pulsa «Revisar chats» de nuevo.';
  } catch (error) { chatMessage.textContent = error.message; chatMessage.className = 'message error'; }
  finally { button.disabled = false; }
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const message = document.getElementById('login-message');
  message.textContent = '';
  try { await post('/api/admin/login', { password: document.getElementById('password').value }); setLoggedIn(true); document.getElementById('password').value = ''; await updateStatus(); await refreshChats(); }
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
document.getElementById('check-chats').addEventListener('click', () => void refreshChats());
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'confirm' || !selectedChat) return;
  const chat = selectedChat;
  selectedChat = null;
  chatMessage.textContent = 'Enviando el contacto a Telegram…';
  try { const result = await post(`/api/admin/chats/${encodeURIComponent(chat.id)}/send`, { confirmation: 'SEND_WHATSAPP_CONTACT' }); await refreshChats(); chatMessage.textContent = result.avatarSent ? 'Contacto y foto de perfil enviados a Telegram.' : 'Contacto enviado a Telegram sin foto de perfil: imagen no disponible.'; chatMessage.className = 'message success'; }
  catch (error) { chatMessage.textContent = error.message; chatMessage.className = 'message error'; }
});

request('/api/admin/session').then(async () => { setLoggedIn(true); await updateStatus(); await refreshChats(); }).catch(() => setLoggedIn(false));
setInterval(() => { if (loggedIn && !document.hidden) void updateStatus(); }, 4_000);
