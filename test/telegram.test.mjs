import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier, validateLead } from '../src/telegram.mjs';

test('accepts an email or phone with optional details', () => {
  assert.deepEqual(validateLead({ method: 'email', value: ' person@example.com ', name: ' Ana ', company: 'Company' }), { method: 'email', value: 'person@example.com', name: 'Ana', company: 'Company' });
  assert.equal(validateLead({ method: 'phone', value: '+7 999 123 45 67' }).value, '+7 999 123 45 67');
});

test('rejects invalid and control-character contacts', () => {
  assert.equal(validateLead({ method: 'email', value: 'bad' }), null);
  assert.equal(validateLead({ method: 'phone', value: 'call me' }), null);
  assert.equal(validateLead({ method: 'email', value: 'good@example.com', name: 'Name\nInjected' }), null);
});

test('sends leads as plain text and WhatsApp contacts with avatar captions', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ ok: true, result: { message_id: 1 } }); };
  try {
    const notifier = new TelegramNotifier('123:fake', '-100123');
    await notifier.lead('email', 'person@example.com', 'Ana', 'Acme');
    const result = await notifier.whatsappContact({ name: 'Мария', number: '79991234567', id: '79991234567@s.whatsapp.net', lastIncomingPreview: 'Привет', lastIncomingAt: Date.now() }, { bytes: Buffer.from('image'), contentType: 'image/jpeg' });
    assert.equal(requests[0].url.endsWith('/sendMessage'), true);
    assert.match(JSON.parse(requests[0].options.body).text, /person@example\.com/);
    assert.equal(requests[1].url.endsWith('/sendPhoto'), true);
    assert.match(requests[1].options.body.get('caption'), /Мария/);
    assert.deepEqual(result, { avatarSent: true });
  } finally { globalThis.fetch = originalFetch; }
});

test('falls back to text when Telegram cannot accept the avatar', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(calls === 1 ? { ok: false, description: 'Photo unavailable' } : { ok: true, result: {} }, { status: calls === 1 ? 400 : 200 }); };
  try {
    const result = await new TelegramNotifier('123:fake', '-100123').whatsappContact({ name: 'Мария', number: '79991234567', id: '79991234567@s.whatsapp.net', lastIncomingPreview: 'Привет', lastIncomingAt: Date.now() }, { bytes: Buffer.from('image'), contentType: 'image/jpeg' });
    assert.deepEqual(result, { avatarSent: false });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});
