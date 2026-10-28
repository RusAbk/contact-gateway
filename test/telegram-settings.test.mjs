import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramSettingsStore, validTelegramChatId, validTelegramToken } from '../src/telegram-settings.mjs';
import { TelegramNotifier } from '../src/telegram.mjs';

test('saves Telegram settings privately and reloads them after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contact-gateway-telegram-'));
  try {
    const first = new TelegramSettingsStore(dir, '123:old', '-100111');
    await first.load();
    assert.equal(first.chatId, '-100111');
    await first.save('456:new', '-100222');
    const path = join(dir, 'telegram.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: '456:new', chatId: '-100222' });
    const restarted = new TelegramSettingsStore(dir, '123:old', '-100111');
    await restarted.load();
    assert.equal(restarted.token, '456:new');
    assert.equal(restarted.chatId, '-100222');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects malformed Telegram IDs and tokens', () => {
  assert.equal(validTelegramToken('123:abc_DEF-9'), true);
  assert.equal(validTelegramToken('https://api.telegram.org/bot123:abc'), false);
  assert.equal(validTelegramChatId('-1005442826868'), true);
  assert.equal(validTelegramChatId('@my_group'), true);
  assert.equal(validTelegramChatId('other chat'), false);
});

test('checks the selected chat before using new Telegram settings', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/bot456:new/getChat');
    assert.deepEqual(JSON.parse(options.body), { chat_id: '-100222' });
    return Response.json({ ok: true, result: { id: -100222 } });
  };
  try { assert.deepEqual(await new TelegramNotifier('456:new', '-100222').verifyChat(), { id: -100222 }); }
  finally { globalThis.fetch = previous; }
});
