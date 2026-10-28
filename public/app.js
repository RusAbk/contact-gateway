const choices = [...document.querySelectorAll('.choice')];
const formPanel = document.getElementById('form-panel');
const whatsappPanel = document.getElementById('whatsapp-panel');
const form = document.getElementById('lead-form');
const valueInput = document.getElementById('contact-value');
const message = document.getElementById('form-message');
const chatLoginForm = document.getElementById('chat-login-form');
const chatLoginMessage = document.getElementById('chat-login-message');
const chatContent = document.getElementById('chat-content');
const chatAuthStatus = document.getElementById('chat-auth-status');
const chatList = document.getElementById('chats-list');
const chatMessage = document.getElementById('chats-message');
const dialog = document.getElementById('send-dialog');
const recipientForm = document.getElementById('recipient-form');
const recipientInput = document.getElementById('recipient-input');
const recipientMessage = document.getElementById('recipient-message');
const outboundForm = document.getElementById('outbound-form');
let selected = null;
let chatLoggedIn = false;
let selectedChat = null;
let resolvedRecipient = null;
let qrScanner = null;
let lookupSerial = 0;

async function request(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('No hay conexión con el servidor. Inténtalo de nuevo.'); }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const detail = typeof result?.error === 'string' ? result.error : `Error del servidor (${response.status}). Inténtalo de nuevo.`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function post(path, payload = {}) { return request(path, { method: 'POST', body: JSON.stringify(payload) }); }

function showMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

async function showWhatsApp() {
  const ready = document.getElementById('whatsapp-ready');
  const unavailable = document.getElementById('whatsapp-unavailable');
  ready.classList.add('hidden');
  unavailable.classList.remove('hidden');
  unavailable.textContent = 'Comprobando la conexión de WhatsApp…';
  try {
    const response = await fetch('/api/whatsapp', { cache: 'no-store' });
    const result = await response.json();
    if (!result.available) { unavailable.textContent = 'WhatsApp no está disponible ahora. Elige correo electrónico o teléfono.'; return; }
    document.getElementById('whatsapp-qr').src = result.qr;
    document.getElementById('whatsapp-link').href = result.url;
    document.getElementById('whatsapp-number').textContent = `WhatsApp: +${result.number}`;
    unavailable.classList.add('hidden');
    ready.classList.remove('hidden');
  } catch { unavailable.textContent = 'No se pudo cargar el código QR. Inténtalo más tarde.'; }
}

for (const button of choices) button.addEventListener('click', () => {
  selected = button.dataset.method;
  for (const choice of choices) choice.setAttribute('aria-pressed', String(choice === button));
  formPanel.classList.toggle('hidden', selected === 'whatsapp');
  whatsappPanel.classList.toggle('hidden', selected !== 'whatsapp');
  showMessage('');
  if (selected === 'whatsapp') { void showWhatsApp(); void checkChatSession(); }
  else {
    stopQrCamera();
    const email = selected === 'email';
    valueInput.type = email ? 'email' : 'tel';
    valueInput.autocomplete = email ? 'email' : 'tel';
    valueInput.inputMode = email ? 'email' : 'tel';
    valueInput.placeholder = email ? 'tu@ejemplo.com' : '+34 600 123 456';
    document.getElementById('contact-label').firstChild.textContent = email ? 'Correo electrónico ' : 'Teléfono ';
    valueInput.value = '';
    valueInput.focus();
  }
});

function setChatAccess(value) {
  chatLoggedIn = value;
  chatAuthStatus.classList.add('hidden');
  document.getElementById('private-header').classList.toggle('hidden', value);
  chatLoginForm.classList.toggle('hidden', value);
  chatContent.classList.toggle('hidden', !value);
  document.getElementById('chats-count').classList.toggle('hidden', !value);
  if (!value) { lookupSerial++; chatList.replaceChildren(); selectedChat = null; resolvedRecipient = null; recipientInput.value = ''; document.getElementById('outbound-text').value = ''; outboundForm.classList.add('hidden'); stopQrCamera(); }
}

async function checkChatSession() {
  chatAuthStatus.textContent = 'Comprobando acceso…';
  chatAuthStatus.classList.remove('hidden');
  chatLoginMessage.textContent = '';
  chatLoginForm.classList.add('hidden');
  chatContent.classList.add('hidden');
  try { await request('/api/admin/session'); setChatAccess(true); await refreshChats(); }
  catch (error) {
    setChatAccess(false);
    if (error.status !== 401) { chatLoginMessage.textContent = error.message; chatLoginMessage.className = 'message error'; }
  }
}

function chatCard(chat) {
  const card = document.createElement('article');
  card.className = 'chat';
  function fallback() { const avatar = document.createElement('div'); avatar.className = 'avatar-fallback'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = chat.name.slice(0, 1).toUpperCase(); return avatar; }
  if (chat.avatarAvailable) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.src = `/api/admin/avatar/${encodeURIComponent(chat.id)}`;
    avatar.onerror = () => { avatar.replaceWith(fallback()); };
    card.append(avatar);
  } else card.append(fallback());
  const main = document.createElement('div'); main.className = 'chat-main';
  const top = document.createElement('div'); top.className = 'chat-top';
  const name = document.createElement('strong'); name.className = 'chat-name'; name.textContent = chat.name;
  const time = document.createElement('time'); time.className = 'chat-time'; time.dateTime = new Date(chat.lastAt).toISOString(); time.textContent = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(chat.lastAt);
  top.append(name, time);
  const preview = document.createElement('p'); preview.className = 'chat-preview'; preview.textContent = chat.preview;
  const meta = document.createElement('p'); meta.className = 'chat-meta'; meta.textContent = chat.number ? `+${chat.number} · Mensaje recibido` : 'WhatsApp · Mensaje recibido';
  main.append(top, preview, meta);
  const button = document.createElement('button'); button.type = 'button'; button.textContent = chat.sent ? 'Ya enviado' : 'Enviar a Telegram'; button.disabled = chat.sent;
  button.addEventListener('click', () => { selectedChat = chat; document.getElementById('send-summary').textContent = `${chat.name}${chat.number ? ` · +${chat.number}` : ''}\nMensaje recibido: ${chat.lastIncomingPreview}${chat.avatarAvailable ? '' : '\nLa foto de perfil no está disponible; solo se enviará texto.'}`; dialog.showModal(); });
  card.append(main, button);
  return card;
}

async function refreshChats() {
  if (!chatLoggedIn) return;
  const button = document.getElementById('check-chats');
  button.disabled = true;
  chatMessage.textContent = 'Actualizando chats…';
  chatMessage.className = 'message';
  try {
    const { chats } = await request('/api/admin/chats');
    chatList.replaceChildren(...chats.map(chatCard));
    document.getElementById('chats-count').textContent = String(chats.length);
    chatMessage.textContent = chats.length ? `Actualizado a las ${new Intl.DateTimeFormat('es-ES', { timeStyle: 'short' }).format(new Date())}` : 'Aún no hay chats con mensajes recibidos.';
  } catch (error) {
    if (error.status === 401) { setChatAccess(false); chatLoginMessage.textContent = 'La sesión ha caducado. Vuelve a entrar.'; chatLoginMessage.className = 'message error'; }
    else { chatMessage.textContent = error.message; chatMessage.className = 'message error'; }
  } finally { button.disabled = false; }
}

chatLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter ?? chatLoginForm.querySelector('[type="submit"]');
  button.disabled = true;
  chatLoginMessage.textContent = '';
  try {
    await post('/api/admin/login', { password: document.getElementById('chat-password').value });
    document.getElementById('chat-password').value = '';
    chatLoginMessage.textContent = '';
    setChatAccess(true);
    await refreshChats();
  } catch (error) { chatLoginMessage.textContent = error.message; chatLoginMessage.className = 'message error'; }
  finally { button.disabled = false; }
});

document.getElementById('check-chats').addEventListener('click', () => void refreshChats());
dialog.addEventListener('close', async () => {
  const chat = selectedChat;
  selectedChat = null;
  if (dialog.returnValue !== 'confirm' || !chat || !chatLoggedIn) return;
  chatMessage.textContent = 'Enviando el contacto a Telegram…';
  try {
    const result = await post(`/api/admin/chats/${encodeURIComponent(chat.id)}/send`, { confirmation: 'SEND_WHATSAPP_CONTACT' });
    await refreshChats();
    if (chatLoggedIn) { chatMessage.textContent = result.avatarSent ? 'Contacto y foto de perfil enviados a Telegram.' : 'Contacto enviado a Telegram sin foto de perfil.'; chatMessage.className = 'message success'; }
  } catch (error) {
    if (error.status === 401) { setChatAccess(false); chatLoginMessage.textContent = 'La sesión ha caducado. Vuelve a entrar.'; chatLoginMessage.className = 'message error'; }
    else { chatMessage.textContent = error.message; chatMessage.className = 'message error'; }
  }
});

function stopQrCamera() {
  const scanner = qrScanner;
  qrScanner = null;
  if (scanner) { scanner.stop(); scanner.destroy(); }
  document.getElementById('qr-camera-panel').classList.add('hidden');
}

function acceptQr(value) {
  stopQrCamera();
  recipientInput.value = typeof value === 'string' ? value.trim() : '';
  recipientInput.dispatchEvent(new Event('input'));
  if (recipientInput.value) void lookupRecipient(recipientInput.value);
  else { recipientMessage.textContent = 'No se pudo leer el contenido del QR.'; recipientMessage.className = 'message error'; }
}

function privateError(error, messageElement) {
  if (error.status === 401) {
    setChatAccess(false);
    chatLoginMessage.textContent = 'La sesión ha caducado. Vuelve a entrar.';
    chatLoginMessage.className = 'message error';
  } else {
    messageElement.textContent = error.message;
    messageElement.className = 'message error';
  }
}

recipientInput.addEventListener('input', () => { lookupSerial++; recipientForm.querySelector('[type="submit"]').disabled = false; resolvedRecipient = null; outboundForm.classList.add('hidden'); recipientMessage.textContent = ''; document.getElementById('outbound-message').textContent = ''; });

function showRecipient(result) {
  const name = result.name || 'Nombre no disponible';
  const number = result.number ? `+${result.number}` : 'WhatsApp';
  document.getElementById('recipient-name').textContent = name;
  document.getElementById('recipient-number').textContent = number;
  const avatar = document.getElementById('recipient-avatar');
  const fallback = document.getElementById('recipient-avatar-fallback');
  fallback.textContent = result.name?.slice(0, 1).toUpperCase() || '?';
  const hasAvatar = typeof result.avatar === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(result.avatar);
  avatar.classList.toggle('hidden', !hasAvatar);
  fallback.classList.toggle('hidden', hasAvatar);
  avatar.onerror = () => { avatar.classList.add('hidden'); fallback.classList.remove('hidden'); };
  if (hasAvatar) avatar.src = result.avatar;
  else avatar.removeAttribute('src');
}

async function lookupRecipient(query) {
  if (!chatLoggedIn) return;
  const serial = ++lookupSerial;
  const button = recipientForm.querySelector('[type="submit"]');
  button.disabled = true;
  resolvedRecipient = null;
  outboundForm.classList.add('hidden');
  recipientMessage.textContent = 'Buscando en WhatsApp…';
  recipientMessage.className = 'message';
  try {
    const result = await post('/api/admin/whatsapp/lookup', { recipient: query });
    if (serial !== lookupSerial || recipientInput.value.trim() !== query) return;
    if (!result.found) { recipientMessage.textContent = 'No se encontró este contacto en WhatsApp.'; return; }
    resolvedRecipient = query;
    showRecipient(result);
    recipientMessage.textContent = '';
    outboundForm.classList.remove('hidden');
  } catch (error) { if (serial === lookupSerial) privateError(error, recipientMessage); }
  finally { if (serial === lookupSerial) button.disabled = false; }
}

recipientForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void lookupRecipient(recipientInput.value.trim());
});

outboundForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chatLoggedIn || !resolvedRecipient) return;
  const button = event.submitter ?? outboundForm.querySelector('[type="submit"]');
  button.disabled = true;
  const status = document.getElementById('outbound-message');
  status.textContent = 'Enviando mensaje…';
  status.className = 'message';
  try {
    await post('/api/admin/whatsapp/send', { recipient: resolvedRecipient, text: document.getElementById('outbound-text').value });
    document.getElementById('outbound-text').value = '';
    status.textContent = 'Mensaje enviado desde la cuenta de WhatsApp conectada.';
    status.className = 'message success';
  } catch (error) { privateError(error, status); }
  finally { button.disabled = false; }
});

document.getElementById('scan-qr').addEventListener('click', async () => {
  if (qrScanner) { stopQrCamera(); return; }
  recipientMessage.textContent = '';
  let accepted = false;
  try {
    const { default: QrScanner } = await import('/qr-scanner.min.js');
    qrScanner = new QrScanner(document.getElementById('qr-video'), (result) => { if (qrScanner) { accepted = true; acceptQr(result?.data ?? result); } }, { preferredCamera: 'environment', returnDetailedScanResult: true });
    document.getElementById('qr-camera-panel').classList.remove('hidden');
    await qrScanner.start();
  } catch {
    stopQrCamera();
    if (!accepted) { recipientMessage.textContent = 'No se pudo abrir la cámara. Usa una imagen QR o introduce el número.'; recipientMessage.className = 'message error'; }
  }
});
document.getElementById('stop-qr').addEventListener('click', stopQrCamera);
document.getElementById('upload-qr').addEventListener('click', () => document.getElementById('qr-file').click());
document.getElementById('qr-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { recipientMessage.textContent = 'La imagen es demasiado grande.'; recipientMessage.className = 'message error'; return; }
  try {
    const { default: QrScanner } = await import('/qr-scanner.min.js');
    const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
    acceptQr(result?.data ?? result);
  } catch { recipientMessage.textContent = 'No se encontró un código QR en la imagen.'; recipientMessage.className = 'message error'; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopQrCamera(); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selected || selected === 'whatsapp') return;
  const submit = document.getElementById('submit-lead');
  submit.disabled = true;
  showMessage('Enviando…');
  try {
    const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: selected, value: valueInput.value, name: document.getElementById('contact-name').value, company: document.getElementById('contact-company').value, website: document.getElementById('website').value }) });
    if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error ?? 'No se pudieron enviar tus datos.'); }
    form.reset();
    showMessage('¡Gracias! Hemos recibido tus datos y pronto nos pondremos en contacto contigo.', 'success');
  } catch (error) { showMessage(error instanceof TypeError ? 'No hay conexión con el servidor. Inténtalo de nuevo.' : error.message, 'error'); }
  finally { submit.disabled = false; }
});
