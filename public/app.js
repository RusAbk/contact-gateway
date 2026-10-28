const choices = [...document.querySelectorAll('.choice')];
const formPanel = document.getElementById('form-panel');
const whatsappPanel = document.getElementById('whatsapp-panel');
const form = document.getElementById('lead-form');
const valueInput = document.getElementById('contact-value');
const message = document.getElementById('form-message');
let selected = null;

function showMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

async function showWhatsApp() {
  const ready = document.getElementById('whatsapp-ready');
  const unavailable = document.getElementById('whatsapp-unavailable');
  ready.classList.add('hidden');
  unavailable.classList.remove('hidden');
  unavailable.textContent = 'Comprobando la conexión de WhatsApp…';
  try {
    const response = await fetch('/api/whatsapp', { cache: 'no-store' });
    const result = await response.json();
    if (!result.available) { unavailable.textContent = 'WhatsApp no está disponible ahora. Elige correo electrónico o teléfono.'; return; }
    document.getElementById('whatsapp-qr').src = result.qr;
    document.getElementById('whatsapp-link').href = result.url;
    document.getElementById('whatsapp-number').textContent = `WhatsApp: +${result.number}`;
    unavailable.classList.add('hidden');
    ready.classList.remove('hidden');
  } catch { unavailable.textContent = 'No se pudo cargar el código QR. Inténtalo más tarde.'; }
}

for (const button of choices) button.addEventListener('click', () => {
  selected = button.dataset.method;
  for (const choice of choices) choice.setAttribute('aria-pressed', String(choice === button));
  formPanel.classList.toggle('hidden', selected === 'whatsapp');
  whatsappPanel.classList.toggle('hidden', selected !== 'whatsapp');
  showMessage('');
  if (selected === 'whatsapp') void showWhatsApp();
  else {
    const email = selected === 'email';
    valueInput.type = email ? 'email' : 'tel';
    valueInput.autocomplete = email ? 'email' : 'tel';
    valueInput.inputMode = email ? 'email' : 'tel';
    valueInput.placeholder = email ? 'tu@ejemplo.com' : '+34 600 123 456';
    document.getElementById('contact-label').firstChild.textContent = email ? 'Correo electrónico ' : 'Teléfono ';
    document.getElementById('form-title').textContent = email ? 'Tu correo electrónico' : 'Tu teléfono';
    valueInput.value = '';
    valueInput.focus();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selected || selected === 'whatsapp') return;
  const submit = document.getElementById('submit-lead');
  submit.disabled = true;
  showMessage('Enviando…');
  try {
    const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: selected, value: valueInput.value, name: document.getElementById('contact-name').value, company: document.getElementById('contact-company').value, website: document.getElementById('website').value }) });
    if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error ?? 'No se pudieron enviar tus datos.'); }
    form.reset();
    showMessage('¡Gracias! Hemos recibido tus datos y pronto nos pondremos en contacto contigo.', 'success');
  } catch (error) { showMessage(error.message, 'error'); }
  finally { submit.disabled = false; }
});
