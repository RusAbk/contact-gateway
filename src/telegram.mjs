const API = 'https://api.telegram.org';

export class TelegramNotifier {
  constructor(token, chatId) {
    this.token = token;
    this.chatId = chatId;
  }

  async call(method, body) {
    const response = await fetch(`${API}/bot${this.token}/${method}`, { method: 'POST', headers: typeof body === 'string' ? { 'Content-Type': 'application/json' } : undefined, body, signal: AbortSignal.timeout(12_000) });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(`Telegram ${method} failed: ${result?.description ?? response.status}`);
    return result.result;
  }

  async text(message) {
    return this.call('sendMessage', JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true }));
  }

  async lead(method, value, name, company) {
    const heading = method === 'email' ? 'Nuevo contacto: correo electrónico' : 'Nuevo contacto: teléfono';
    const lines = [heading, value, name ? `Nombre: ${name}` : null, company ? `Empresa: ${company}` : null].filter(Boolean);
    return this.text(lines.join('\n'));
  }

  async whatsappContact(chat, avatar) {
    const lines = ['Nuevo contacto: WhatsApp', `Nombre: ${chat.name}`, chat.number ? `Teléfono: +${chat.number}` : `ID de WhatsApp: ${chat.id}`, `Último mensaje recibido: ${chat.lastIncomingPreview}`, `Fecha: ${new Date(chat.lastIncomingAt).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`];
    const text = lines.join('\n').slice(0, 1000);
    if (avatar) {
      const form = new FormData();
      form.set('chat_id', this.chatId);
      form.set('caption', text);
      form.set('photo', new Blob([avatar.bytes], { type: avatar.contentType }), 'avatar');
      try { await this.call('sendPhoto', form); return { avatarSent: true }; } catch { /* send text when the photo is unavailable */ }
    }
    await this.text(text);
    return { avatarSent: false };
  }
}

export function validateLead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const method = input.method;
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  if (!['email', 'phone'].includes(method) || !value || value.length > 200 || name.length > 100 || company.length > 120) return null;
  if (/[\r\n\u0000-\u001f]/.test(`${value}${name}${company}`)) return null;
  if (method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  if (method === 'phone' && !/^\+?[0-9][0-9 ()-]{5,22}$/.test(value)) return null;
  return { method, value, name, company };
}
