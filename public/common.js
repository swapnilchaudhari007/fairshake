// bits shared by both pages
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Something went wrong');
  return json;
}

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2800);
}

const fmt = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);
const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let CONFIG = null;
async function loadConfig() {
  CONFIG = await api('/config');
  const m = $('#modes');
  if (m) {
    m.innerHTML =
      `<span class="pill ${CONFIG.paypal.mock ? 'warn' : 'ok'}">PayPal: ${CONFIG.paypal.mock ? 'mock' : CONFIG.paypal.env}</span>` +
      `<span class="pill ${CONFIG.ai.enabled ? 'ok' : 'warn'}">AI: ${esc(CONFIG.ai.model)}</span>`;
  }
  return CONFIG;
}

// disable a button while its promise runs
async function busy(btn, fn, label = 'Working…') {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = old; }
}
