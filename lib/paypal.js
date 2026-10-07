// PayPal Orders v2 + Payments v2, the parts Fairshake needs:
//   create order (intent AUTHORIZE) -> buyer approves -> authorize
//   later: capture some or all of the authorization (final_capture releases the rest)
//   or void it if nothing was delivered.
//
// If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing we run a fake in-memory
// PayPal so the app can still be clicked through. The UI shows a banner when that happens.

const crypto = require('crypto');

const ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const BASE = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const MOCK = !CLIENT_ID || !SECRET || process.env.PAYPAL_MOCK === '1';

let tokenCache = { value: null, expires: 0 };

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60_000) return tokenCache.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  tokenCache = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return tokenCache.value;
}

async function call(method, path, body, requestId) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  // PayPal-Request-Id makes retries safe: same id = same result, no double capture
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json.details?.[0]?.description || json.message || text;
    const err = new Error(`PayPal ${method} ${path} -> ${res.status}: ${detail}`);
    err.status = res.status;
    err.paypal = json;
    err.debugId = res.headers.get('paypal-debug-id');
    throw err;
  }
  return json;
}

const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// ---------- real calls ----------

async function createOrder({ gigId, title, amount, currency, payeeEmail, returnUrl, cancelUrl }) {
  const unit = {
    reference_id: gigId,
    custom_id: gigId,
    description: `Fairshake: ${title}`.slice(0, 127),
    soft_descriptor: 'FAIRSHAKE',
    amount: { currency_code: currency, value: money(amount) },
  };
  // send funds straight to the freelancer's PayPal account when we know it
  if (payeeEmail) unit.payee = { email_address: payeeEmail };
  return call('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [unit],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Fairshake',
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
          // used by the redirect flow (no JS SDK), ignored by the popup buttons
          ...(returnUrl ? { return_url: returnUrl, cancel_url: cancelUrl || returnUrl } : {}),
        },
      },
    },
  }, `order-${gigId}-${crypto.randomBytes(3).toString('hex')}`);
}

async function authorizeOrder(orderId) {
  const order = await call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
  const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error('PayPal returned no authorization for order ' + orderId);
  return {
    orderId,
    authorizationId: auth.id,
    status: auth.status,
    expiresAt: auth.expiration_time,
    payer: order.payer ? { name: order.payer.name, email: order.payer.email_address } : null,
  };
}

async function captureAuthorization({ authorizationId, amount, currency, note, requestKey }) {
  const cap = await call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
    amount: { currency_code: currency, value: money(amount) },
    final_capture: true, // whatever we don't capture goes back to the buyer
    note_to_payer: (note || '').slice(0, 255) || undefined,
    soft_descriptor: 'FAIRSHAKE',
  }, requestKey || `cap-${authorizationId}`);
  return { captureId: cap.id, status: cap.status, amount: cap.amount };
}

async function voidAuthorization(authorizationId) {
  await call('POST', `/v2/payments/authorizations/${authorizationId}/void`, null, `void-${authorizationId}`);
  return { status: 'VOIDED' };
}

async function getAuthorization(authorizationId) {
  return call('GET', `/v2/payments/authorizations/${authorizationId}`);
}

// ---------- fake PayPal for offline runs ----------

const fake = {
  orders: new Map(),
  id: (p) => p + crypto.randomBytes(6).toString('hex').toUpperCase(),
};

const mock = {
  async createOrder({ amount, currency }) {
    const id = fake.id('MOCKORD');
    fake.orders.set(id, { amount: money(amount), currency });
    return { id, status: 'CREATED' };
  },
  async authorizeOrder(orderId) {
    if (!fake.orders.has(orderId)) throw new Error('Unknown mock order ' + orderId);
    const exp = new Date(Date.now() + 29 * 864e5).toISOString();
    return { orderId, authorizationId: fake.id('MOCKAUTH'), status: 'CREATED', expiresAt: exp, payer: { email: 'buyer@example.test' } };
  },
  async captureAuthorization({ amount, currency }) {
    return { captureId: fake.id('MOCKCAP'), status: 'COMPLETED', amount: { currency_code: currency, value: money(amount) } };
  },
  async voidAuthorization() {
    return { status: 'VOIDED' };
  },
  async getAuthorization(id) {
    return { id, status: 'CREATED' };
  },
};

module.exports = MOCK
  ? { mock: true, env: 'mock', clientId: '', ...mock, money }
  : { mock: false, env: ENV, clientId: CLIENT_ID, createOrder, authorizeOrder, captureAuthorization, voidAuthorization, getAuthorization, money };
