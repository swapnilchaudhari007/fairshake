// End-to-end walk through the whole gig lifecycle against mock PayPal.
// Run: npm test
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), 'fairshake-test-' + Date.now());
process.env.PAYPAL_MOCK = '1';
const app = require('../server');

(async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = async (p, body, method) => {
    const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(p + ': ' + j.error);
    return j;
  };
  try {
    let g = await call('/gigs', {
      title: 'Bakery copy',
      brief: 'Write a headline for the bakery.\nWrite an about section mentioning mother and daughter.\nList five menu items with prices.',
      amount: 100, clientName: 'Priya', freelancerName: 'Rahul',
    });
    assert.equal(g.status, 'draft');
    assert.equal(g.criteria.reduce((s, c) => s + c.weight, 0), 100, 'weights sum to 100');

    g = await call(`/gigs/${g.id}/criteria`, { criteria: [{ text: 'Headline for the bakery', weight: 30 }, { text: 'About section mentions mother and daughter', weight: 30 }, { text: 'Five menu items with prices', weight: 40 }] }, 'PUT');
    assert.deepEqual(g.criteria.map((c) => c.weight), [30, 30, 40]);

    const { id } = await call(`/gigs/${g.id}/order`, {});
    g = await call(`/gigs/${g.id}/authorize`, { orderId: id });
    assert.equal(g.status, 'funded');
    assert.ok(g.paypal.authorizationId);

    // can't edit the checklist after funding
    await assert.rejects(call(`/gigs/${g.id}/criteria`, { criteria: [{ text: 'x', weight: 100 }] }, 'PUT'));

    g = await call(`/gigs/${g.id}/deliver`, { content: 'Headline: Fresh bakery bread baked every morning.\nAbout: Run by a mother and daughter team.' });
    assert.equal(g.status, 'delivered');
    assert.equal(g.review.items.length, 3);
    console.log('review:', g.review.items.map((i) => `${i.id}=${i.verdict}`).join(' '), '->', g.review.suggestedPercent + '%');

    g = await call(`/gigs/${g.id}/request-changes`, { message: 'menu please' });
    assert.equal(g.status, 'changes_requested');
    g = await call(`/gigs/${g.id}/deliver`, { content: 'Headline: Fresh bakery. About: mother and daughter. Menu: five items with prices.' });

    g = await call(`/gigs/${g.id}/release`, { verdicts: { c1: 'met', c2: 'met', c3: 'partial' }, message: 'thanks' });
    assert.equal(g.status, 'settled');
    assert.equal(g.settlement.percent, 80);
    assert.equal(g.settlement.paid, 80);
    assert.equal(g.settlement.returned, 20);

    // zero percent -> void instead of capture
    let z = await call('/gigs', { title: 'Nothing', brief: 'Design a logo for the shop please.', amount: 50 });
    const o2 = await call(`/gigs/${z.id}/order`, {});
    await call(`/gigs/${z.id}/authorize`, { orderId: o2.id });
    await call(`/gigs/${z.id}/deliver`, { content: 'sorry, ran out of time' });
    z = await call(`/gigs/${z.id}/release`, { verdicts: Object.fromEntries(z.criteria.map((c) => [c.id, 'missing'])) });
    assert.equal(z.status, 'refunded');
    assert.equal(z.settlement.paid, 0);

    console.log('all good ✔');
  } finally {
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
