import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipientQuery, validateOutboundText } from '../src/recipient.mjs';
import { WhatsAppManager } from '../src/whatsapp.mjs';

test('accepts international numbers and WhatsApp links without trusting other URLs', () => {
  assert.deepEqual(parseRecipientQuery('+34 600 123 456'), { type: 'phone', value: '34600123456' });
  assert.deepEqual(parseRecipientQuery('https://wa.me/34600123456?text=hola'), { type: 'phone', value: '34600123456' });
  assert.deepEqual(parseRecipientQuery('https://api.whatsapp.com/send?phone=%2B34600123456'), { type: 'phone', value: '34600123456' });
  assert.deepEqual(parseRecipientQuery('https://wa.me/qr/ABCD123456'), { type: 'qr', value: 'ABCD123456' });
  assert.deepEqual(parseRecipientQuery('https://api.whatsapp.com/message/ABCD123456'), { type: 'qr', value: 'ABCD123456' });
  assert.equal(parseRecipientQuery('https://evil.example/qr/ABCD123456'), null);
  assert.equal(parseRecipientQuery('https://wa.me.evil.example/34600123456'), null);
  assert.equal(parseRecipientQuery('https://wa.me/qr/../../admin'), null);
});

test('outbound messages need meaningful, bounded text', () => {
  assert.equal(validateOutboundText(' Hola\nAna '), 'Hola\nAna');
  assert.equal(validateOutboundText('   '), null);
  assert.equal(validateOutboundText('x'.repeat(2001)), null);
  assert.equal(validateOutboundText('Hola\u0000Ana'), null);
});

test('finds a number and sends through the connected WhatsApp socket', async () => {
  const calls = [];
  const manager = new WhatsAppManager('/unused');
  manager.state = 'connected';
  manager.socket = {
    onWhatsApp: async (number) => { calls.push(['lookup', number]); return [{ jid: `${number}@s.whatsapp.net`, exists: true }]; },
    sendMessage: async (jid, content) => { calls.push(['send', jid, content]); },
  };
  const recipient = parseRecipientQuery('+34 600 123 456');
  assert.deepEqual(await manager.resolveRecipient(recipient), { jid: '34600123456@s.whatsapp.net', name: null, number: '34600123456' });
  await manager.sendToRecipient(recipient, 'Hola');
  assert.deepEqual(calls.at(-1), ['send', '34600123456@s.whatsapp.net', { text: 'Hola' }]);
});

test('resolves a personal WhatsApp QR link before sending', async () => {
  const calls = [];
  const manager = new WhatsAppManager('/unused');
  manager.state = 'connected';
  manager.socket = {
    query: async (node) => { calls.push(node); return { tag: 'iq', attrs: {}, content: [{ tag: 'qr', attrs: { jid: '123456789@lid', notify: 'Ana' } }] }; },
    sendMessage: async (jid, content) => { calls.push(['send', jid, content]); },
  };
  const recipient = parseRecipientQuery('https://wa.me/qr/ABCD123456');
  assert.deepEqual(await manager.sendToRecipient(recipient, 'Hola Ana'), { jid: '123456789@lid', name: 'Ana', number: null });
  assert.equal(calls[0].attrs.xmlns, 'w:qr');
  assert.deepEqual(calls[0].content[0], { tag: 'qr', attrs: { code: 'ABCD123456' } });
  assert.deepEqual(calls[1], ['send', '123456789@lid', { text: 'Hola Ana' }]);
});
