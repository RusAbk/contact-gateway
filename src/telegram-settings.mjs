import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validTelegramToken(value) {
  return typeof value === 'string' && /^\d+:[A-Za-z0-9_-]+$/.test(value);
}

export function validTelegramChatId(value) {
  return typeof value === 'string' && (/^-?\d+$/.test(value) || /^@[A-Za-z0-9_]{5,32}$/.test(value));
}

export class TelegramSettingsStore {
  constructor(dataDir, token, chatId) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'telegram.json');
    this.token = token;
    this.chatId = chatId;
  }

  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (!validTelegramToken(saved?.token) || !validTelegramChatId(saved?.chatId)) throw new Error('Invalid stored Telegram settings');
    this.token = saved.token;
    this.chatId = saved.chatId;
  }

  async save(token, chatId) {
    if (!validTelegramToken(token) || !validTelegramChatId(chatId)) throw new Error('Invalid Telegram settings');
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ token, chatId }), { mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
    this.token = token;
    this.chatId = chatId;
  }
}
