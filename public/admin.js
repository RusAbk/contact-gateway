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
    const error = new Error(result?.error ?? 'Не удалось выполнить запрос.');
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
    const labels = { starting: 'Запуск', connecting: 'Подключение', pairing: 'Ждём сканирования', connected: 'Подключён', reconnecting: 'Переподключение', logged_out: 'Не подключён' };
    document.getElementById('wa-status').textContent = labels[status.state] ?? status.state;
    document.getElementById('connection-note').textContent = status.state === 'connected' ? `Аккаунт подключён${status.connectedAs ? `: ${status.connectedAs}` : ''}. Новые сообщения попадают в список чатов.` : status.state === 'pairing' ? 'Сканируйте QR-код с телефона. После привязки он исчезнет автоматически.' : 'Если подключение не восстановится, нажмите «Обновить подключение».';
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
  const time = document.createElement('time'); time.className = 'chat-time'; time.dateTime = new Date(chat.lastAt).toISOString(); time.textContent = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(chat.lastAt);
  top.append(name, time);
  const preview = document.createElement('p'); preview.className = 'chat-preview'; preview.textContent = chat.preview;
  const meta = document.createElement('p'); meta.className = 'chat-meta'; meta.textContent = chat.number ? `+${chat.number} · Есть входящее сообщение` : 'WhatsApp · Есть входящее сообщение';
  main.append(top, preview, meta);
  const button = document.createElement('button'); button.type = 'button'; button.textContent = chat.sent ? 'Уже отправлен' : 'Выбрать контакт'; button.disabled = chat.sent;
  button.addEventListener('click', () => { selectedChat = chat; document.getElementById('send-summary').textContent = `${chat.name}${chat.number ? ` · +${chat.number}` : ''}\nВходящее: ${chat.lastIncomingPreview}${chat.avatarAvailable ? '' : '\nАватар недоступен; отправится только текст.'}`; dialog.showModal(); });
  card.append(main, button);
  return card;
}

async function refreshChats() {
  const button = document.getElementById('check-chats');
  button.disabled = true;
  chatMessage.textContent = 'Обновляем последние чаты, имена и аватарки…';
  chatMessage.className = 'message';
  try {
    const { chats } = await request('/api/admin/chats');
    chatList.replaceChildren(...chats.map(chatCard));
    document.getElementById('chats-count').textContent = String(chats.length);
    chatMessage.textContent = chats.length ? `Обновлено: ${new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short' }).format(new Date())}` : 'Пока нет чатов с входящим сообщением. После сообщения нажмите «Проверить чаты» ещё раз.';
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
document.getElementById('wa-logout-button').addEventListener('click', async () => { if (!confirm('Отвязать WhatsApp Web? Посетители не увидят QR-код до нового подключения.')) return; await post('/api/admin/whatsapp/logout'); await updateStatus(); });
document.getElementById('number-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.getElementById('number-message');
  try { await post('/api/admin/number', { number: document.getElementById('public-number-input').value }); message.textContent = 'Номер сохранён.'; message.className = 'message success'; await updatePublicQr(); }
  catch (error) { message.textContent = error.message; message.className = 'message error'; }
});
document.getElementById('check-chats').addEventListener('click', () => void refreshChats());
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'confirm' || !selectedChat) return;
  const chat = selectedChat;
  selectedChat = null;
  chatMessage.textContent = 'Отправляем контакт в Telegram…';
  try { const result = await post(`/api/admin/chats/${encodeURIComponent(chat.id)}/send`, { confirmation: 'SEND_WHATSAPP_CONTACT' }); await refreshChats(); chatMessage.textContent = result.avatarSent ? 'Контакт и аватар отправлены в Telegram.' : 'Контакт отправлен в Telegram без аватара: изображение недоступно.'; chatMessage.className = 'message success'; }
  catch (error) { chatMessage.textContent = error.message; chatMessage.className = 'message error'; }
});

request('/api/admin/session').then(async () => { setLoggedIn(true); await updateStatus(); await refreshChats(); }).catch(() => setLoggedIn(false));
setInterval(() => { if (loggedIn && !document.hidden) void updateStatus(); }, 4_000);
