require('./lib/env').loadEnv();

const express = require('express');
const path = require('path');
const net = require('net');
const store = require('./lib/store');
const paypal = require('./lib/paypal');
const ai = require('./lib/ai');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'USD';

// small helper so every route can just throw
const route = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status || e.status >= 500) console.error(e);
    else console.warn(`${req.method} ${req.path}: ${e.message}`);
    res.status(e.status && e.status < 500 ? 400 : 500).json({ error: e.message, debugId: e.debugId });
  });

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function mustGig(id) {
  const g = store.get(id);
  if (!g) throw Object.assign(new Error('Gig not found'), { status: 404 });
  return g;
}

function mustBe(gig, ...statuses) {
  if (!statuses.includes(gig.status)) throw bad(`Can't do that while the gig is "${gig.status}"`);
}

// ---------- config ----------

app.get('/api/config', (req, res) => {
  res.json({
    currency: CURRENCY,
    paypal: { mock: paypal.mock, env: paypal.env, clientId: paypal.clientId },
    ai: { enabled: ai.enabled, model: ai.model },
  });
});

// ---------- gigs ----------

app.get('/api/gigs', (req, res) => res.json(store.list()));
app.get('/api/gigs/:id', route((req, res) => res.json(mustGig(req.params.id))));

app.post('/api/gigs', route(async (req, res) => {
  const { title, brief, amount, clientName, freelancerName, freelancerEmail, dueDate } = req.body || {};
  if (!title || !brief) throw bad('Title and brief are required');
  const amt = Number(amount);
  if (!(amt >= 1 && amt <= 10000)) throw bad('Amount should be between 1 and 10,000');

  const draft = await ai.draftCriteria({ title, brief });
  const gig = {
    id: store.newId('gig'),
    title: String(title).slice(0, 120),
    brief: String(brief).slice(0, 5000),
    amount: Number(paypal.money(amt)),
    currency: CURRENCY,
    clientName: clientName || 'Client',
    freelancerName: freelancerName || 'Freelancer',
    freelancerEmail: freelancerEmail || '',
    dueDate: dueDate || null,
    criteria: draft.criteria,
    criteriaSource: draft.source,
    status: 'draft',
    createdAt: new Date().toISOString(),
    deliveries: [],
    timeline: [],
  };
  store.log(gig, 'client', `Created the gig for ${gig.currency} ${gig.amount}`);
  store.log(gig, 'ai', `Drafted ${gig.criteria.length} checklist items (${draft.source})`);
  res.json(store.put(gig));
}));

// client can edit the checklist until money is held. After that it's locked,
// otherwise the goalposts could move after the freelancer starts.
app.put('/api/gigs/:id/criteria', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'draft');
  const list = (req.body.criteria || [])
    .map((c) => ({ text: String(c.text || '').trim().slice(0, 200), weight: Math.max(1, Math.round(Number(c.weight) || 1)) }))
    .filter((c) => c.text);
  if (!list.length) throw bad('Need at least one checklist item');
  gig.criteria = ai.fixWeights(list).map((c, i) => ({ id: 'c' + (i + 1), ...c }));
  store.log(gig, 'client', 'Edited the checklist');
  res.json(store.put(gig));
}));

// ---------- money in: authorize, don't capture ----------

app.post('/api/gigs/:id/order', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'draft');
  const order = await paypal.createOrder({
    gigId: gig.id,
    title: gig.title,
    amount: gig.amount,
    currency: gig.currency,
    payeeEmail: gig.freelancerEmail,
  });
  gig.paypal = { ...(gig.paypal || {}), orderId: order.id };
  store.put(gig);
  res.json({ id: order.id });
}));

app.post('/api/gigs/:id/authorize', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'draft');
  const orderId = req.body.orderId || gig.paypal?.orderId;
  if (!orderId) throw bad('No PayPal order to authorize');
  const auth = await paypal.authorizeOrder(orderId);
  gig.paypal = { ...gig.paypal, ...auth };
  gig.status = 'funded';
  store.log(gig, 'paypal', `Held ${gig.currency} ${gig.amount} on the client's PayPal (authorization ${auth.authorizationId}). Nothing charged yet.`);
  res.json(store.put(gig));
}));

// ---------- work in ----------

app.post('/api/gigs/:id/deliver', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'funded', 'changes_requested');
  const { note = '', content = '', link = '' } = req.body || {};
  if (!content.trim() && !link.trim()) throw bad('Paste the work or add a link');

  const delivery = {
    id: store.newId('dlv'),
    at: new Date().toISOString(),
    note: String(note).slice(0, 2000),
    content: String(content).slice(0, 60000),
    link: String(link).trim(),
  };
  if (delivery.link) {
    try {
      delivery.fetched = await fetchReadable(delivery.link);
    } catch (e) {
      delivery.fetchError = e.message;
    }
  }
  gig.deliveries.push(delivery);
  gig.status = 'delivered';
  store.log(gig, 'freelancer', `Submitted delivery #${gig.deliveries.length}`);

  gig.review = await ai.reviewDelivery({ title: gig.title, brief: gig.brief, criteria: gig.criteria, delivery });
  gig.review.deliveryId = delivery.id;
  store.log(gig, 'ai', `Reviewed it: ${gig.review.suggestedPercent}% of the checklist is there (${gig.review.source})`);
  res.json(store.put(gig));
}));

app.post('/api/gigs/:id/review', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'delivered');
  const delivery = gig.deliveries[gig.deliveries.length - 1];
  gig.review = await ai.reviewDelivery({ title: gig.title, brief: gig.brief, criteria: gig.criteria, delivery });
  gig.review.deliveryId = delivery.id;
  store.log(gig, 'ai', `Re-reviewed: ${gig.review.suggestedPercent}%`);
  res.json(store.put(gig));
}));

app.post('/api/gigs/:id/request-changes', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'delivered');
  const msg = String(req.body.message || '').trim().slice(0, 1000);
  gig.status = 'changes_requested';
  gig.changeRequest = { at: new Date().toISOString(), message: msg, missing: (gig.review?.items || []).filter((i) => i.verdict !== 'met').map((i) => i.id) };
  store.log(gig, 'client', `Asked for changes${msg ? `: "${msg}"` : ''}`);
  res.json(store.put(gig));
}));

// ---------- money out: capture what was earned, release the rest ----------

app.post('/api/gigs/:id/release', route(async (req, res) => {
  const gig = mustGig(req.params.id);
  mustBe(gig, 'delivered');
  if (!gig.review) throw bad('Run the review first');

  // client may override individual verdicts; we keep a record of every change
  const overrides = req.body.verdicts || {};
  const finalItems = gig.review.items.map((it) => {
    const v = overrides[it.id];
    if (v && v !== it.verdict && ai.VERDICT_SCORE[v] !== undefined) {
      store.log(gig, 'client', `Changed "${gig.criteria.find((c) => c.id === it.id)?.text}" from ${it.verdict} to ${v}`);
      return { ...it, verdict: v, overridden: true, aiVerdict: it.verdict };
    }
    return it;
  });
  const pct = ai.payoutPercent(gig.criteria, finalItems);
  const payAmount = Number(paypal.money((gig.amount * pct) / 100));
  const returned = Number(paypal.money(gig.amount - payAmount));
  const message = String(req.body.message || '').slice(0, 255);

  let result;
  if (payAmount < 0.01) {
    result = await paypal.voidAuthorization(gig.paypal.authorizationId);
    gig.status = 'refunded';
    store.log(gig, 'paypal', `Voided the hold. ${gig.currency} ${gig.amount} released back to the client.`);
  } else {
    result = await paypal.captureAuthorization({
      authorizationId: gig.paypal.authorizationId,
      amount: payAmount,
      currency: gig.currency,
      note: message || `Fairshake: ${pct}% of "${gig.title}"`,
      requestKey: `cap-${gig.id}-${gig.deliveries.length}`,
    });
    gig.status = 'settled';
    store.log(gig, 'paypal', `Captured ${gig.currency} ${payAmount} for ${gig.freelancerName} (capture ${result.captureId}).` +
      (returned > 0 ? ` The other ${gig.currency} ${returned} was released back to the client.` : ''));
  }
  gig.settlement = { at: new Date().toISOString(), percent: pct, paid: payAmount, returned, message, items: finalItems, paypal: result };
  res.json(store.put(gig));
}));

// ---------- helpers ----------

async function fetchReadable(link) {
  let url;
  try { url = new URL(link); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) links');
  const host = url.hostname;
  // don't let a delivery link poke at our own network
  if (host === 'localhost' || host.endsWith('.local') || (net.isIP(host) && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|fc|fd)/.test(host))) {
    throw new Error('Private addresses are not allowed');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Fairshake-reviewer/1.0' } });
    if (!r.ok) throw new Error(`Link returned ${r.status}`);
    const raw = (await r.text()).slice(0, 400000);
    return raw
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000);
  } finally {
    clearTimeout(t);
  }
}

app.get(['/gig/:id', '/gig/:id/:role'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'gig.html')));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Fairshake on http://localhost:${PORT}`);
    console.log(`  PayPal: ${paypal.mock ? 'MOCK (no keys in .env)' : paypal.env}`);
    console.log(`  AI:     ${ai.enabled ? ai.model : 'offline keyword checker (no key in .env)'}`);
  });
}

module.exports = app;
