import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatIndex, usableName } from '../src/chats.mjs';

test('normalizes LID and PN identities without splitting one person into two chats', () => {
  const index = new ChatIndex();
  index.acceptMessage({ key: { remoteJid: '12345@lid', id: 'a', fromMe: false }, messageTimestamp: 100, pushName: 'Ирина', message: { conversation: 'Здравствуйте' } });
  index.mapLid('79991234567@s.whatsapp.net', '12345@lid');
  index.acceptMessage({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'b', fromMe: false }, messageTimestamp: 101, message: { conversation: 'Нужна консультация' } });
  assert.equal(index.list().length, 1);
  assert.deepEqual(index.list()[0], { id: '79991234567@s.whatsapp.net', name: 'Ирина', number: '79991234567', preview: 'Нужна консультация', lastAt: 101000, lastIncomingAt: 101000, lastIncomingPreview: 'Нужна консультация', sent: false });
});

test('saved contact name outranks push name and outgoing own name cannot overwrite it', () => {
  const index = new ChatIndex();
  index.acceptContact({ id: '79991234567@s.whatsapp.net', name: 'Мария Контакт' });
  index.acceptMessage({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'a', fromMe: false }, messageTimestamp: 100, pushName: 'Маша', message: { conversation: 'Привет' } });
  index.acceptMessage({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'b', fromMe: true }, messageTimestamp: 101, pushName: 'Моё имя', message: { conversation: 'Ответ' } });
  assert.equal(index.list()[0].name, 'Мария Контакт');
  assert.equal(index.list()[0].lastIncomingPreview, 'Привет');
});

test('uses message alternate number and rejects low quality names', () => {
  const index = new ChatIndex();
  index.acceptMessage({ key: { remoteJid: '98765@lid', remoteJidAlt: '79991234567@s.whatsapp.net', id: 'a', fromMe: false }, messageTimestamp: 100, pushName: '79991234567', message: { imageMessage: {} } });
  assert.equal(index.list()[0].id, '79991234567@s.whatsapp.net');
  assert.equal(index.list()[0].name, '+79991234567');
  assert.equal(index.list()[0].preview, 'Фото');
  assert.equal(usableName('You'), null);
  assert.equal(usableName('12345@lid'), null);
});

test('only chats with real incoming content can be selected and sent once per message', () => {
  const index = new ChatIndex();
  index.acceptMessage({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'a', fromMe: true }, messageTimestamp: 100, message: { conversation: 'Привет' } });
  assert.equal(index.selected('79991234567@s.whatsapp.net'), null);
  index.acceptMessage({ key: { remoteJid: '79991234567@s.whatsapp.net', id: 'b', fromMe: false }, messageTimestamp: 101, message: { conversation: 'Здравствуйте' } });
  assert.equal(index.selected('79991234567@s.whatsapp.net').incomingKey, '79991234567@s.whatsapp.net:b');
  index.markSent(index.selected('79991234567@s.whatsapp.net').incomingKey);
  assert.equal(index.list()[0].sent, true);
});

test('keeps sent state when a LID later resolves to a phone JID', () => {
  const index = new ChatIndex();
  index.acceptMessage({ key: { remoteJid: '12345@lid', id: 'incoming', fromMe: false }, messageTimestamp: 100, message: { conversation: 'Привет' } });
  index.markSent(index.selected('12345@lid').incomingKey);
  index.mapLid('79991234567@s.whatsapp.net', '12345@lid');
  assert.equal(index.list()[0].sent, true);
});
