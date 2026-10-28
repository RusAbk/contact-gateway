function phoneNumber(value) {
  if (typeof value !== 'string' || !/^\+?[0-9 ()-]{7,30}$/.test(value)) return null;
  const number = value.replace(/\D/g, '');
  return /^\d{7,15}$/.test(number) ? number : null;
}

export function parseRecipientQuery(input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  const value = input.trim();
  const direct = phoneNumber(value);
  if (direct) return { type: 'phone', value: direct };

  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/, '');
  if (host === 'wa.me') {
    const number = phoneNumber(path.slice(1));
    if (number) return { type: 'phone', value: number };
    const qr = path.match(/^\/(qr|message)\/([A-Za-z0-9_-]{6,80})$/);
    if (qr) return { type: 'qr', value: qr[2] };
  }
  if (host === 'api.whatsapp.com') {
    if (path === '/send') {
      const number = phoneNumber(url.searchParams.get('phone'));
      if (number) return { type: 'phone', value: number };
    }
    const qr = path.match(/^\/(qr|message)\/([A-Za-z0-9_-]{6,80})$/);
    if (qr) return { type: 'qr', value: qr[2] };
  }
  return null;
}

export function validateOutboundText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  return text;
}
