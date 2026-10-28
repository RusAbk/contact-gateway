import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, getBinaryNodeChild, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { ChatIndex, normalizeJid, phoneFromJid, usableName } from './chats.mjs';

const logger = pino({ level: 'silent' });
const pictureHosts = /(^|\.)(whatsapp\.net|whatsapp\.com|fbcdn\.net)$/i;

export class WhatsAppManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.authDir = join(dataDir, 'wa-auth');
    this.index = new ChatIndex();
    this.state = 'starting';
    this.qr = null;
    this.socket = null;
    this.generation = 0;
    this.persistTimer = null;
    this.avatarCache = new Map();
    this.publicNumber = null;
    this.inferredNumber = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try { this.index = new ChatIndex(JSON.parse(await readFile(join(this.dataDir, 'chats.json'), 'utf8'))); } catch { /* fresh installation */ }
    try { this.publicNumber = JSON.parse(await readFile(join(this.dataDir, 'settings.json'), 'utf8')).publicNumber ?? null; } catch { /* fresh installation */ }
    await this.connect();
  }

  async connect() {
    const generation = ++this.generation;
    this.state = 'connecting';
    this.qr = null;
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const socket = makeWASocket({ auth: state, logger, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false, shouldSyncHistoryMessage: () => true });
    this.socket = socket;
    socket.ev.on('creds.update', () => { if (generation === this.generation) void saveCreds().catch((error) => logger.error({ error }, 'Unable to save WhatsApp credentials')); });
    socket.ev.on('connection.update', (update) => { void (async () => {
      if (generation !== this.generation) return;
      if (update.qr) { this.qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 320 }); this.state = 'pairing'; }
      if (update.connection === 'open') {
        this.qr = null;
        this.state = 'connected';
        const self = normalizeJid(socket.user?.id ?? state.creds.me?.id);
        const inferred = phoneFromJid(self);
        if (inferred) { this.inferredNumber = inferred; await this.setPublicNumber(inferred); }
        else if (self.endsWith('@lid')) {
          const pn = await Promise.race([socket.signalRepository.lidMapping.getPNForLID(self).catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), 3_000))]);
          if (phoneFromJid(pn)) { this.inferredNumber = phoneFromJid(pn); await this.setPublicNumber(this.inferredNumber); }
        }
      }
      if (update.connection === 'close') {
        this.qr = null;
        const status = update.lastDisconnect?.error?.output?.statusCode;
        this.socket = null;
        if (status === DisconnectReason.loggedOut) { await this.logout(); return; }
        this.state = 'reconnecting';
        setTimeout(() => { if (generation === this.generation) void this.connect().catch((error) => logger.error({ error }, 'WhatsApp reconnect failed')); }, 5_000);
      }
    })().catch((error) => logger.error({ error }, 'WhatsApp connection update failed')); });
    socket.ev.on('messaging-history.set', (event) => {
      if (generation !== this.generation) return;
      for (const mapping of event.lidPnMappings ?? []) this.index.mapLid(mapping.pn, mapping.lid);
      for (const contact of event.contacts ?? []) this.index.acceptContact(contact);
      for (const chat of event.chats ?? []) this.index.acceptChat(chat);
      for (const message of event.messages ?? []) this.index.acceptMessage(message);
      this.schedulePersist();
    });
    socket.ev.on('lid-mapping.update', (mapping) => { if (generation !== this.generation) return; this.index.mapLid(mapping.pn, mapping.lid); this.schedulePersist(); });
    socket.ev.on('contacts.upsert', (contacts) => { if (generation !== this.generation) return; for (const contact of contacts) this.index.acceptContact(contact); this.schedulePersist(); });
    socket.ev.on('contacts.update', (contacts) => { if (generation !== this.generation) return; for (const contact of contacts) this.index.acceptContact(contact); this.schedulePersist(); });
    socket.ev.on('chats.upsert', (chats) => { if (generation !== this.generation) return; for (const chat of chats) this.index.acceptChat(chat); this.schedulePersist(); });
    socket.ev.on('chats.update', (chats) => { if (generation !== this.generation) return; for (const chat of chats) this.index.acceptChat(chat); this.schedulePersist(); });
    socket.ev.on('messages.upsert', (event) => {
      if (generation !== this.generation) return;
      if (event.requestId) return;
      for (const message of event.messages) this.index.acceptMessage(message);
      this.schedulePersist();
    });
  }

  async logout() {
    ++this.generation;
    const socket = this.socket;
    this.socket = null;
    this.state = 'logged_out';
    this.qr = null;
    this.publicNumber = null;
    this.inferredNumber = null;
    this.index = new ChatIndex();
    this.avatarCache.clear();
    if (socket) await socket.logout().catch(() => socket.end(new Error('Admin disconnected WhatsApp')));
    await rm(this.authDir, { recursive: true, force: true });
    await this.setPublicNumber(null);
    await this.atomicWrite('chats.json', this.index.serialize());
  }

  async reconnect() {
    if (this.socket) { this.socket.end(new Error('Admin restarted WhatsApp connection')); this.socket = null; }
    await this.connect();
  }

  async setPublicNumber(value) {
    if (value !== null && !/^\d{7,15}$/.test(value)) throw new Error('Invalid WhatsApp number');
    if (value !== null && this.inferredNumber && value !== this.inferredNumber) throw new Error('Number does not match the connected WhatsApp account');
    this.publicNumber = value;
    await this.atomicWrite('settings.json', { publicNumber: value });
  }

  async publicLink() {
    if (this.state !== 'connected' || !this.publicNumber) return { available: false };
    const url = `https://wa.me/${this.publicNumber}`;
    return { available: true, url, qr: await QRCode.toDataURL(url, { margin: 2, width: 300 }), number: this.publicNumber };
  }

  async pairingStatus() {
    return { state: this.state, pairingQr: this.qr, number: this.publicNumber, connectedAs: this.socket?.user?.name ?? null };
  }

  async resolveRecipient(recipient) {
    const socket = this.socket;
    if (this.state !== 'connected' || !socket) throw new Error('WhatsApp is not connected');
    let jid;
    let name = null;
    if (recipient.type === 'phone') {
      const result = await socket.onWhatsApp(recipient.value);
      jid = result?.find((item) => item.exists)?.jid;
    } else {
      let result;
      try {
        result = await socket.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:qr' }, content: [{ tag: 'qr', attrs: { code: recipient.value } }] }, 12_000);
      } catch (error) {
        if (error?.output?.statusCode === 404) return null;
        throw error;
      }
      const qr = getBinaryNodeChild(result, 'qr');
      jid = qr?.attrs?.jid;
      name = usableName(qr?.attrs?.notify, [jid]);
    }
    jid = normalizeJid(jid);
    if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
    if (socket !== this.socket || this.state !== 'connected') throw new Error('WhatsApp disconnected during recipient lookup');
    return { jid, name: name ?? this.index.contacts.get(this.index.canonical(jid))?.name ?? null, number: phoneFromJid(jid) ?? (recipient.type === 'phone' ? recipient.value : null) };
  }

  async recipientAvatarDataUrl(jid) {
    const socket = this.socket;
    if (this.state !== 'connected' || !socket) return null;
    const url = await socket.profilePictureUrl(jid, 'preview', 5_000).catch(() => null);
    if (socket !== this.socket || this.state !== 'connected') return null;
    const avatar = await this.fetchAvatarBytes(this.safePictureUrl(url), 256 * 1024, 5_000).catch(() => null);
    return avatar ? `data:${avatar.contentType};base64,${avatar.bytes.toString('base64')}` : null;
  }

  async sendToRecipient(recipient, text) {
    const socket = this.socket;
    const target = await this.resolveRecipient(recipient);
    if (!target) return null;
    if (this.state !== 'connected' || !socket || socket !== this.socket) throw new Error('WhatsApp disconnected before sending');
    await socket.sendMessage(target.jid, { text });
    return target;
  }

  async recentChats() {
    const chats = this.index.list(40);
    if (this.state === 'connected') await Promise.all(chats.slice(0, 20).map(async (chat) => { await this.avatarUrl(chat.id); }));
    return chats.map((chat) => ({ ...chat, avatarAvailable: this.avatarCache.get(chat.id)?.url !== null && Boolean(this.avatarCache.get(chat.id)?.url) }));
  }

  async avatarUrl(jid) {
    const id = this.index.canonical(jid);
    if (!this.index.selected(id) || !this.socket || this.state !== 'connected') return null;
    const cached = this.avatarCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const url = await this.socket.profilePictureUrl(id, 'preview', 5_000).catch(() => null);
    const safe = this.safePictureUrl(url);
    this.avatarCache.set(id, { url: safe, expiresAt: Date.now() + 5 * 60_000 });
    return safe;
  }

  safePictureUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && pictureHosts.test(url.hostname) ? url.href : null; } catch { return null; }
  }

  async avatarBytes(jid) {
    return this.fetchAvatarBytes(await this.avatarUrl(jid));
  }

  async fetchAvatarBytes(url, maxBytes = 3 * 1024 * 1024, timeoutMs = 8_000) {
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }).catch(() => null);
    const contentType = String(response?.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!response?.ok || !response.body || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maxBytes) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { await response.body.cancel().catch(() => {}); return null; }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }

  selectedChat(jid) { return this.state === 'connected' ? this.index.selected(jid) : null; }
  markSent(key) { this.index.markSent(key); this.schedulePersist(); }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.atomicWrite('chats.json', this.index.serialize()).catch((error) => logger.error({ error }, 'Unable to persist chats')); }, 1_000);
  }

  async atomicWrite(name, value) {
    const path = join(this.dataDir, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  }
}
