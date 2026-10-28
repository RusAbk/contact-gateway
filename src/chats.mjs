const PN = /^(\d{7,15})@s\.whatsapp\.net$/;
const LID = /^\d+@lid$/;

export function normalizeJid(value) {
  if (typeof value !== 'string') return '';
  const [user, server] = value.trim().split('@');
  if (!user || !server) return '';
  return `${user.split(':')[0]}@${server}`;
}

export function phoneFromJid(value) {
  return PN.exec(normalizeJid(value))?.[1] ?? null;
}

export function usableName(value, identities = []) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 100 || /^(unknown|undefined|null|you)$/i.test(name)) return null;
  if (/@(?:lid|s\.whatsapp\.net|g\.us)$/i.test(name)) return null;
  const compact = name.replace(/[\s+().-]/g, '');
  if (identities.includes(name) || identities.includes(compact)) return null;
  if (/^\d{7,}$/.test(compact)) return null;
  return name;
}

function previewMessage(message) {
  let content = message;
  for (let i = 0; i < 3; i++) {
    if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content?.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else break;
  }
  const value = content?.conversation ?? content?.extendedTextMessage?.text ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption;
  if (typeof value === 'string' && value.trim()) return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (content?.imageMessage) return 'Фото';
  if (content?.videoMessage) return 'Видео';
  if (content?.audioMessage) return 'Голосовое сообщение';
  if (content?.documentMessage) return `Файл: ${String(content.documentMessage.fileName ?? 'документ').slice(0, 120)}`;
  if (content?.stickerMessage) return 'Стикер';
  if (content?.contactMessage || content?.contactsArrayMessage) return 'Контакт';
  if (content?.locationMessage || content?.liveLocationMessage) return 'Геолокация';
  return null;
}

function timestampMs(value) {
  const seconds = typeof value === 'object' && value !== null && 'low' in value ? Number(value.low) : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}

export class ChatIndex {
  constructor(saved = {}) {
    this.aliases = new Map(Object.entries(saved.aliases ?? {}));
    this.contacts = new Map(Object.entries(saved.contacts ?? {}));
    this.chats = new Map(Object.entries(saved.chats ?? {}));
    this.sent = new Set(saved.sent ?? []);
  }

  canonical(jid) {
    let current = normalizeJid(jid);
    for (let i = 0; i < 3 && this.aliases.has(current); i++) current = this.aliases.get(current);
    return current;
  }

  mapLid(pn, lid) {
    const phoneJid = normalizeJid(pn);
    const lidJid = normalizeJid(lid);
    if (!PN.test(phoneJid) || !LID.test(lidJid)) return;
    this.aliases.set(lidJid, phoneJid);
    for (const key of this.sent) if (key.startsWith(`${lidJid}:`)) { this.sent.delete(key); this.sent.add(`${phoneJid}:${key.slice(lidJid.length + 1)}`); }
    this.merge(lidJid, phoneJid);
  }

  merge(from, to) {
    if (from === to) return;
    const oldContact = this.contacts.get(from);
    const newContact = this.contacts.get(to);
    if (oldContact && (!newContact || oldContact.rank > newContact.rank)) this.contacts.set(to, oldContact);
    this.contacts.delete(from);
    const oldChat = this.chats.get(from);
    const newChat = this.chats.get(to);
    if (oldChat) {
      this.chats.set(to, { ...oldChat, ...newChat, ...(oldChat.lastAt > (newChat?.lastAt ?? 0) ? { lastAt: oldChat.lastAt, preview: oldChat.preview, lastMessageId: oldChat.lastMessageId } : {}), ...(oldChat.lastIncomingAt > (newChat?.lastIncomingAt ?? 0) ? { lastIncomingAt: oldChat.lastIncomingAt, lastIncomingId: oldChat.lastIncomingId, lastIncomingPreview: oldChat.lastIncomingPreview } : {}) });
      this.chats.delete(from);
    }
  }

  setName(jid, source, value) {
    const canonical = this.canonical(jid);
    if (!canonical) return;
    const identities = [jid, canonical, jid.split('@')[0], canonical.split('@')[0]];
    const name = usableName(value, identities);
    if (!name) return;
    const rank = { contact: 5, verified: 4, notify: 3, chat: 3, push: 2 }[source] ?? 1;
    const previous = this.contacts.get(canonical);
    if (!previous || rank >= previous.rank) this.contacts.set(canonical, { name, rank });
  }

  acceptContact(contact) {
    const jid = normalizeJid(contact?.id);
    if (!jid) return;
    if (contact?.phoneNumber && LID.test(jid)) this.mapLid(contact.phoneNumber, jid);
    this.setName(jid, 'contact', contact.name);
    this.setName(jid, 'verified', contact.verifiedName);
    this.setName(jid, 'notify', contact.notify);
  }

  acceptChat(chat) {
    const jid = normalizeJid(chat?.id);
    if (!jid || (!PN.test(jid) && !LID.test(jid))) return;
    this.setName(jid, 'chat', chat.name);
    this.setName(jid, 'verified', chat.verifiedName);
    this.setName(jid, 'notify', chat.notify);
  }

  acceptMessage(message) {
    const rawJid = normalizeJid(message?.key?.remoteJid);
    if (!PN.test(rawJid) && !LID.test(rawJid)) return;
    const alt = normalizeJid(message.key.remoteJidAlt);
    if (PN.test(alt) && LID.test(rawJid)) this.mapLid(alt, rawJid);
    if (PN.test(rawJid) && LID.test(alt)) this.mapLid(rawJid, alt);
    const jid = this.canonical(rawJid);
    const preview = previewMessage(message.message);
    if (!preview) return;
    const at = timestampMs(message.messageTimestamp);
    if (!message.key.fromMe) this.setName(jid, 'push', message.pushName);
    const chat = this.chats.get(jid) ?? { id: jid, lastAt: 0, lastIncomingAt: 0 };
    const messageId = String(message.key.id ?? at);
    if (at >= chat.lastAt) Object.assign(chat, { lastAt: at, preview, lastMessageId: messageId, fromMe: Boolean(message.key.fromMe) });
    if (!message.key.fromMe && at >= chat.lastIncomingAt) Object.assign(chat, { lastIncomingAt: at, lastIncomingId: messageId, lastIncomingPreview: preview });
    this.chats.set(jid, chat);
  }

  list(limit = 40) {
    return [...this.chats.values()].filter((chat) => chat.lastIncomingAt > 0).sort((a, b) => b.lastAt - a.lastAt).slice(0, limit).map((chat) => {
      const jid = this.canonical(chat.id);
      const number = phoneFromJid(jid);
      return { id: jid, name: this.contacts.get(jid)?.name ?? (number ? `+${number}` : 'Контакт WhatsApp'), number, preview: chat.preview, lastAt: chat.lastAt, lastIncomingAt: chat.lastIncomingAt, lastIncomingPreview: chat.lastIncomingPreview, sent: this.sent.has(`${jid}:${chat.lastIncomingId}`) };
    });
  }

  selected(jid) {
    const canonical = this.canonical(jid);
    const chat = this.chats.get(canonical);
    if (!chat?.lastIncomingId) return null;
    const item = this.list(200).find((candidate) => candidate.id === canonical);
    return item ? { ...item, incomingKey: `${canonical}:${chat.lastIncomingId}` } : null;
  }

  markSent(key) { this.sent.add(key); }

  serialize() {
    return { aliases: Object.fromEntries(this.aliases), contacts: Object.fromEntries(this.contacts), chats: Object.fromEntries(this.chats), sent: [...this.sent].slice(-500) };
  }
}
