import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { TelegramNotifier, validateLead } from './telegram.mjs';
import { TelegramSettingsStore, validTelegramChatId, validTelegramToken } from './telegram-settings.mjs';
import { WhatsAppManager } from './whatsapp.mjs';
import { parseRecipientQuery, validateOutboundText } from './recipient.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const staticDir = join(base, '..', 'public');
const config = {
  port: Number(process.env.PORT ?? 8080),
  origin: process.env.PUBLIC_ORIGIN,
  dataDir: process.env.DATA_DIR ?? join(base, '..', 'data'),
  botToken: process.env.BOT_TOKEN,
  botChatId: process.env.BOT_CHAT_ID,
  adminHash: process.env.ADMIN_PASSWORD_HASH,
  sessionSecret: process.env.SESSION_SECRET,
  secure: process.env.NODE_ENV === 'production',
};
if (!/^https?:\/\/[^/]+$/.test(config.origin ?? '') || !config.botToken || !config.botChatId || !config.adminHash || !config.sessionSecret || config.sessionSecret.length < 64) throw new Error('Missing or invalid app configuration.');
const [salt, expectedHex] = config.adminHash.split(':');
if (!/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(expectedHex ?? '')) throw new Error('Invalid admin password hash.');

const app = Fastify({ logger: true, bodyLimit: 16 * 1024, trustProxy: true });
await app.register(cookie);
const whatsapp = new WhatsAppManager(config.dataDir);
const telegramSettings = new TelegramSettingsStore(config.dataDir, config.botToken, config.botChatId);
await telegramSettings.load().catch((err) => { app.log.error({ err }, 'Could not load stored Telegram settings; using environment values'); });
let telegram = new TelegramNotifier(telegramSettings.token, telegramSettings.chatId);
const limits = new Map();
const sessions = new Set();
const sending = new Set();

function limited(key, max, windowMs) {
  const now = Date.now();
  const previous = limits.get(key);
  const current = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
  current.count++;
  limits.set(key, current);
  if (limits.size > 5_000) for (const [entry, value] of limits) if (value.until <= now) limits.delete(entry);
  return current.count > max;
}

function checkOrigin(request, reply) {
  if (request.headers.origin !== config.origin) { reply.code(403).send({ error: 'Origen de la solicitud no permitido.' }); return false; }
  return true;
}

function verifyPassword(value) {
  if (typeof value !== 'string' || value.length > 1_000) return false;
  const actual = scryptSync(value, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

function sessionToken() {
  sessions.clear();
  const expiry = Date.now() + 12 * 60 * 60_000;
  const payload = `${expiry}.${randomBytes(16).toString('hex')}`;
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
  const token = `${payload}.${signature}`;
  sessions.add(token);
  return token;
}

function authenticated(token) {
  if (typeof token !== 'string' || !sessions.has(token)) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
  if (Number(parts[0]) < Date.now()) { sessions.delete(token); return false; }
  const signature = createHmac('sha256', config.sessionSecret).update(`${parts[0]}.${parts[1]}`).digest();
  return timingSafeEqual(signature, Buffer.from(parts[2], 'hex'));
}

function requireAdmin(request, reply) {
  if (!authenticated(request.cookies.cg_session)) { reply.code(401).send({ error: 'Inicia sesión en el panel de administración.' }); return false; }
  return true;
}

app.addHook('onRequest', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  reply.header('Cache-Control', 'no-store');
});

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};
for (const [path, [name, type]] of Object.entries(staticFiles)) app.get(path, async (_request, reply) => reply.type(type).send(createReadStream(join(staticDir, name))));
for (const name of ['qr-scanner.min.js', 'qr-scanner-worker.min.js']) app.get(`/${name}`, async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(createReadStream(join(base, '..', 'node_modules', 'qr-scanner', name))));
app.get('/health', async () => ({ ok: true }));
app.get('/api/whatsapp', async () => whatsapp.publicLink());

app.post('/api/leads', async (request, reply) => {
  if (!checkOrigin(request, reply)) return;
  if (limited(`lead:${request.ip}`, 5, 60 * 60_000)) return reply.code(429).send({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' });
  if (request.body?.website) return reply.code(204).send();
  const lead = validateLead(request.body);
  if (!lead) return reply.code(422).send({ error: 'Revisa tus datos de contacto.' });
  try { await telegram.lead(lead.method, lead.value, lead.name, lead.company); }
  catch (error) { app.log.error({ err: error }, 'Failed to notify Telegram'); return reply.code(502).send({ error: 'No se pudieron enviar tus datos. Inténtalo de nuevo más tarde.' }); }
  return reply.code(204).send();
});

app.post('/api/admin/login', async (request, reply) => {
  if (!checkOrigin(request, reply)) return;
  if (limited(`login:${request.ip}`, 8, 15 * 60_000)) return reply.code(429).send({ error: 'Demasiados intentos de inicio de sesión.' });
  if (!verifyPassword(request.body?.password)) return reply.code(401).send({ error: 'Contraseña incorrecta.' });
  reply.setCookie('cg_session', sessionToken(), { path: '/api/admin', httpOnly: true, secure: config.secure, sameSite: 'strict', maxAge: 12 * 60 * 60 });
  return { ok: true };
});
app.get('/api/admin/session', async (request, reply) => requireAdmin(request, reply) ? { ok: true } : undefined);
app.post('/api/admin/logout', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  sessions.delete(request.cookies.cg_session);
  reply.clearCookie('cg_session', { path: '/api/admin' });
  return { ok: true };
});
app.get('/api/admin/status', async (request, reply) => requireAdmin(request, reply) ? whatsapp.pairingStatus() : undefined);
app.get('/api/admin/telegram/settings', async (request, reply) => requireAdmin(request, reply) ? { chatId: telegram.chatId, tokenConfigured: true } : undefined);
app.post('/api/admin/telegram/settings', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  const chatId = typeof request.body?.chatId === 'string' ? request.body.chatId.trim() : '';
  const enteredToken = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
  const token = enteredToken || telegram.token;
  if (!validTelegramChatId(chatId) || !validTelegramToken(token)) return reply.code(422).send({ error: 'Revisa el ID del chat y el token del bot.' });
  const candidate = new TelegramNotifier(token, chatId);
  try { await candidate.verifyChat(); }
  catch (err) { app.log.error({ err }, 'Telegram settings verification failed'); return reply.code(502).send({ error: 'El bot no puede acceder a este chat. Revisa el token, el ID y los permisos.' }); }
  await telegramSettings.save(token, chatId);
  telegram = candidate;
  return { ok: true, chatId };
});
app.post('/api/admin/whatsapp/reconnect', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  await whatsapp.reconnect();
  return { ok: true };
});
app.post('/api/admin/whatsapp/logout', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  await whatsapp.logout();
  return { ok: true };
});
app.post('/api/admin/number', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  const number = String(request.body?.number ?? '').replace(/[+\s()-]/g, '');
  if (!/^\d{7,15}$/.test(number)) return reply.code(422).send({ error: 'Introduce el número en formato internacional.' });
  await whatsapp.setPublicNumber(number);
  return { ok: true };
});
app.post('/api/admin/whatsapp/lookup', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  const recipient = parseRecipientQuery(request.body?.recipient);
  if (!recipient) return reply.code(422).send({ error: 'Introduce un número internacional o escanea un QR de WhatsApp válido.' });
  if (limited(`lookup:${request.ip}`, 30, 60 * 60_000)) return reply.code(429).send({ error: 'Demasiadas búsquedas. Inténtalo más tarde.' });
  if (whatsapp.state !== 'connected') return reply.code(503).send({ error: 'Conecta WhatsApp antes de buscar contactos.' });
  try {
    const target = await whatsapp.resolveRecipient(recipient);
    if (!target) return { found: false };
    const avatar = await whatsapp.recipientAvatarDataUrl(target.jid);
    return { found: true, name: target.name, number: target.number, avatar };
  } catch (error) {
    app.log.error({ err: error, firstError: error instanceof AggregateError ? error.errors[0] : undefined, secondError: error instanceof AggregateError ? error.errors[1] : undefined }, 'WhatsApp recipient lookup failed');
    return reply.code(502).send({ error: recipient.type === 'qr' ? 'No se pudo resolver este QR con WhatsApp. Inténtalo de nuevo o usa el número.' : 'No se pudo buscar el contacto en WhatsApp. Inténtalo de nuevo.' });
  }
});
app.post('/api/admin/whatsapp/send', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  const recipient = parseRecipientQuery(request.body?.recipient);
  const text = validateOutboundText(request.body?.text);
  if (!recipient || !text) return reply.code(422).send({ error: 'Revisa el destinatario y el mensaje.' });
  if (limited(`send:${request.ip}`, 10, 60 * 60_000)) return reply.code(429).send({ error: 'Demasiados mensajes. Inténtalo más tarde.' });
  if (whatsapp.state !== 'connected') return reply.code(503).send({ error: 'Conecta WhatsApp antes de enviar mensajes.' });
  try {
    const target = await whatsapp.sendToRecipient(recipient, text);
    if (!target) return reply.code(404).send({ error: 'No se encontró este contacto en WhatsApp.' });
    return { ok: true, number: target.number, name: target.name };
  } catch (error) {
    app.log.error({ err: error }, 'WhatsApp outbound message failed');
    return reply.code(502).send({ error: 'No se pudo enviar el mensaje por WhatsApp. Inténtalo de nuevo.' });
  }
});
app.get('/api/admin/chats', async (request, reply) => requireAdmin(request, reply) ? { chats: await whatsapp.recentChats() } : undefined);
app.get('/api/admin/avatar/:jid', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const avatar = await whatsapp.avatarBytes(request.params.jid).catch(() => null);
  if (!avatar) return reply.code(404).send({ error: 'La foto de perfil no está disponible.' });
  return reply.type(avatar.contentType).send(avatar.bytes);
});
app.post('/api/admin/chats/:jid/send', async (request, reply) => {
  if (!checkOrigin(request, reply) || !requireAdmin(request, reply)) return;
  if (request.body?.confirmation !== 'SEND_WHATSAPP_CONTACT') return reply.code(422).send({ error: 'Confirma el envío del contacto.' });
  const chat = whatsapp.selectedChat(request.params.jid);
  if (!chat) return reply.code(404).send({ error: 'No se encontró un chat con mensajes recibidos.' });
  if (chat.sent || sending.has(chat.incomingKey)) return reply.code(409).send({ error: 'Este contacto ya se está enviando o ya se envió.' });
  sending.add(chat.incomingKey);
  try {
    const avatar = await whatsapp.avatarBytes(chat.id).catch(() => null);
    const result = await telegram.whatsappContact(chat, avatar);
    whatsapp.markSent(chat.incomingKey);
    return { ok: true, avatarSent: result.avatarSent };
  } catch (error) {
    app.log.error({ err: error }, 'Failed to notify Telegram');
    return reply.code(502).send({ error: 'No se pudo enviar el contacto. Inténtalo de nuevo más tarde.' });
  } finally { sending.delete(chat.incomingKey); }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error({ err: error }, 'Request failed');
  reply.code(500).send({ error: 'Error del servidor. Inténtalo más tarde.' });
});

await whatsapp.init().catch((error) => { app.log.error({ err: error }, 'WhatsApp startup failed; reconnect from the admin panel'); });
await app.listen({ host: '0.0.0.0', port: config.port });
