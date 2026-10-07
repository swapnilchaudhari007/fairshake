// One page, two seats: /gig/:id is the client, /gig/:id/freelancer is the freelancer.
const [, , GIG_ID, ROLE_RAW] = location.pathname.split('/');
const ROLE = ROLE_RAW === 'freelancer' ? 'freelancer' : 'client';
const SCORE = { met: 1, partial: 0.5, missing: 0 };
let gig = null;
let paypalLoaded = null;

const STEPS = [
  ['draft', 'Agree on checklist'],
  ['funded', 'Money on hold'],
  ['delivered', 'Work delivered'],
  ['settled', 'Settled'],
];

function stepIndex(status) {
  if (status === 'changes_requested') return 1;
  if (status === 'refunded') return 3;
  return STEPS.findIndex(([s]) => s === status);
}

async function load() {
  gig = await api('/gigs/' + GIG_ID);
  render();
}

function render() {
  const g = gig;
  const idx = stepIndex(g.status);
  const other = ROLE === 'client' ? 'freelancer' : '';
  $('#app').innerHTML = `
    ${CONFIG.paypal.mock ? `<div class="banner">PayPal keys aren't set, so this is running against a fake PayPal. Add sandbox keys in <code>.env</code> to use the real sandbox.</div>` : ''}
    <div class="spread">
      <div>
        <h1>${esc(g.title)}</h1>
        <p class="muted" style="margin:0">${esc(g.clientName)} hiring ${esc(g.freelancerName)}${g.dueDate ? ` · due ${esc(g.dueDate)}` : ''}</p>
      </div>
      <div style="text-align:right">
        <div class="money">${fmt(g.amount, g.currency)}</div>
        <span class="status ${g.status}">${g.status.replace('_', ' ')}</span>
      </div>
    </div>
    <div class="row" style="margin:14px 0 6px">
      <div class="tabs">
        <a href="/gig/${g.id}" class="${ROLE === 'client' ? 'on' : ''}">Client view</a>
        <a href="/gig/${g.id}/freelancer" class="${ROLE === 'freelancer' ? 'on' : ''}">Freelancer view</a>
      </div>
      <span class="muted small">(in real use each person only gets their own link)</span>
    </div>
    <ol class="steps">${STEPS.map(([, label], i) => `<li class="${i < idx || g.status === 'settled' || g.status === 'refunded' ? 'done' : i === idx ? 'now' : ''}">${label}</li>`).join('')}</ol>
    <div id="main"></div>
    <div class="card">
      <h3>Brief</h3>
      <p style="white-space:pre-wrap;margin:0" class="small">${esc(g.brief)}</p>
    </div>
    <div class="card">
      <h3>What happened</h3>
      <ul class="timeline">${g.timeline.slice().reverse().map((t) => `
        <li><span class="muted">${when(t.at)}</span><span class="who ${t.who}">${t.who === 'ai' ? 'AI' : t.who === 'paypal' ? 'PayPal' : t.who}</span><span>${esc(t.text)}</span></li>`).join('')}
      </ul>
    </div>`;
  const main = $('#main');
  const view = (ROLE === 'client' ? CLIENT : FREELANCER)[g.status];
  if (view) view(main);
}

// ---------------- client ----------------

const CLIENT = {
  draft(el) {
    el.innerHTML = `
      <div class="card">
        <div class="spread"><h2>Checklist</h2><span class="muted small">drafted by ${esc(gig.criteriaSource)}</span></div>
        <p class="muted small">This is what "done" means. Each line is worth a share of the budget. Edit anything, then lock it in by putting the money on hold. Once funded, it can't change.</p>
        <div id="crit"></div>
        <div class="spread" style="margin-top:6px">
          <button class="link" id="add">+ add an item</button>
          <span class="small" id="total"></span>
        </div>
        <div class="row" style="margin-top:12px"><button class="ghost" id="saveCrit">Save checklist</button></div>
      </div>
      <div class="card">
        <h2>Put ${fmt(gig.amount, gig.currency)} on hold</h2>
        <p class="muted small" style="margin-top:0">You approve the payment in PayPal, but nothing is charged yet. PayPal only places an authorization.
          When the work comes in you'll capture what was earned and the rest is released back to you.</p>
        ${CONFIG.paypal.mock
          ? `<button class="green" id="mockFund">Hold with test PayPal</button>`
          : `<div id="paypal-buttons"></div>`}
      </div>`;
    drawCriteria(gig.criteria);
    $('#add').onclick = () => drawCriteria([...readCriteria(), { text: '', weight: 10 }]);
    $('#saveCrit').onclick = (e) => busy(e.target, async () => {
      gig = await api(`/gigs/${gig.id}/criteria`, { method: 'PUT', body: { criteria: readCriteria() } });
      toast('Checklist saved'); render();
    });
    if (CONFIG.paypal.mock) {
      $('#mockFund').onclick = (e) => busy(e.target, async () => {
        await api(`/gigs/${gig.id}/criteria`, { method: 'PUT', body: { criteria: readCriteria() } });
        const { id } = await api(`/gigs/${gig.id}/order`, { body: {} });
        gig = await api(`/gigs/${gig.id}/authorize`, { body: { orderId: id } });
        toast('Money is on hold'); render();
      });
    } else {
      mountPayPal();
    }
  },

  funded(el) { el.innerHTML = waitingCard(); wireCopy(); },
  changes_requested(el) { el.innerHTML = waitingCard(true); wireCopy(); },

  delivered(el) {
    const r = gig.review;
    const d = gig.deliveries[gig.deliveries.length - 1];
    el.innerHTML = `
      <div class="card">
        <div class="spread"><h2>The review</h2><span class="muted small">by ${esc(r.source)} · delivery #${gig.deliveries.length}</span></div>
        ${r.warning ? `<div class="banner">AI call failed, fell back to the offline checker: ${esc(r.warning)}</div>` : ''}
        <div class="summary">${esc(r.summary)}</div>
        <p class="muted small">You have the final say. Change any verdict and the split updates. Every change you make is written to the history so the freelancer can see it.</p>
        <div id="verdicts"></div>
        <div class="split"><div class="pay" id="barPay"></div><div class="back" id="barBack"></div></div>
        <div class="legend"><span><b id="payAmt"></b> to ${esc(gig.freelancerName)}</span><span><b id="backAmt"></b> back to you</span></div>
        <div class="field" style="margin-top:16px">
          <label for="msg">Note to ${esc(gig.freelancerName)} <span class="hint">(optional, shows on the PayPal capture)</span></label>
          <input id="msg" maxlength="200" placeholder="Thanks! Menu prices still need filling in.">
        </div>
        <div class="row">
          <button class="green" id="release">Release payment</button>
          <button class="ghost" id="changes">Ask for changes instead</button>
          <button class="link" id="rerun">Run the review again</button>
        </div>
      </div>
      ${deliveryCard(d)}`;
    $('#verdicts').innerHTML = r.items.map((it) => verdictRow(it, true)).join('');
    const update = () => {
      const v = currentVerdicts();
      const pct = gig.criteria.reduce((s, c) => s + c.weight * SCORE[v[c.id]], 0);
      const pay = Math.round(gig.amount * pct) / 100;
      $('#barPay').style.width = pct + '%';
      $('#barBack').style.width = 100 - pct + '%';
      $('#payAmt').textContent = `${fmt(pay, gig.currency)} (${Math.round(pct * 10) / 10}%)`;
      $('#backAmt').textContent = fmt(gig.amount - pay, gig.currency);
      $('#release').textContent = pay > 0 ? `Release ${fmt(pay, gig.currency)}` : 'Cancel the hold and refund';
      document.querySelectorAll('.verdict').forEach((row) => { row.className = 'verdict ' + v[row.dataset.id]; });
    };
    el.querySelectorAll('select').forEach((s) => (s.onchange = update));
    update();
    $('#release').onclick = (e) => {
      if (!confirm(e.target.textContent + '? This captures on PayPal and can\'t be undone here.')) return;
      busy(e.target, async () => {
        gig = await api(`/gigs/${gig.id}/release`, { body: { verdicts: currentVerdicts(), message: $('#msg').value } });
        toast('Done'); render();
      }, 'Talking to PayPal…');
    };
    $('#changes').onclick = (e) => {
      const message = prompt('What should they fix? (the unmet checklist items are sent along automatically)', $('#msg').value);
      if (message === null) return;
      busy(e.target, async () => { gig = await api(`/gigs/${gig.id}/request-changes`, { body: { message } }); render(); });
    };
    $('#rerun').onclick = (e) => busy(e.target, async () => { gig = await api(`/gigs/${gig.id}/review`, { body: {} }); render(); }, 'Reviewing…');
  },

  settled(el) { el.innerHTML = receiptCard(); },
  refunded(el) { el.innerHTML = receiptCard(); },
};

// ---------------- freelancer ----------------

const FREELANCER = {
  draft(el) {
    el.innerHTML = `
      <div class="card">
        <h2>Not funded yet</h2>
        <p class="muted">${esc(gig.clientName)} is still finalising the checklist below. Don't start until the money is on hold, you'll see it here.</p>
        ${critList()}
      </div>`;
  },
  funded(el) { el.innerHTML = deliverForm(); wireDeliver(); },
  changes_requested(el) { el.innerHTML = deliverForm(); wireDeliver(); },
  delivered(el) {
    const r = gig.review;
    el.innerHTML = `
      <div class="card">
        <h2>Submitted, waiting for ${esc(gig.clientName)}</h2>
        <p class="muted small">This is exactly what the client sees. If the AI got something wrong, mention it in your next note, the client can override any line.</p>
        <div class="summary">${esc(r.summary)}</div>
        ${r.items.map((it) => verdictRow(it, false)).join('')}
        <p><b>Suggested payout:</b> ${r.suggestedPercent}% = ${fmt(Math.round(gig.amount * r.suggestedPercent) / 100, gig.currency)}</p>
      </div>`;
  },
  settled(el) { el.innerHTML = receiptCard(); },
  refunded(el) { el.innerHTML = receiptCard(); },
};

// ---------------- pieces ----------------

function critList() {
  return `<ul class="critview">${gig.criteria.map((c) => `<li><span>${esc(c.text)}</span><span class="w">${c.weight}% · ${fmt((gig.amount * c.weight) / 100, gig.currency)}</span></li>`).join('')}</ul>`;
}

function drawCriteria(list) {
  $('#crit').innerHTML = list.map((c) => `
    <div class="crit">
      <input class="t" value="${esc(c.text)}" placeholder="Something you can check in the delivery">
      <input class="wt" type="number" min="1" max="100" value="${c.weight}" title="share of the budget, %">
      <button class="x" title="remove">×</button>
    </div>`).join('');
  $('#crit').querySelectorAll('.x').forEach((b, i) => (b.onclick = () => { const l = readCriteria(); l.splice(i, 1); drawCriteria(l); }));
  $('#crit').querySelectorAll('input').forEach((i) => (i.oninput = sumWeights));
  sumWeights();
}

function readCriteria() {
  return [...document.querySelectorAll('#crit .crit')].map((r) => ({ text: $('.t', r).value, weight: Number($('.wt', r).value) || 1 }));
}

function sumWeights() {
  const t = readCriteria().reduce((s, c) => s + c.weight, 0);
  $('#total').innerHTML = t === 100 ? `<span style="color:var(--green)">adds up to 100%</span>` : `<span style="color:var(--amber)">adds up to ${t}%, will be scaled to 100 on save</span>`;
}

function mountPayPal() {
  const url = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.paypal.clientId)}&intent=authorize&currency=${gig.currency}&components=buttons`;
  paypalLoaded = paypalLoaded || new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = url; s.onload = ok; s.onerror = () => fail(new Error('Could not load PayPal'));
    document.head.appendChild(s);
  });
  paypalLoaded.then(() => {
    paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay' },
      createOrder: async () => {
        await api(`/gigs/${gig.id}/criteria`, { method: 'PUT', body: { criteria: readCriteria() } });
        const { id } = await api(`/gigs/${gig.id}/order`, { body: {} });
        return id;
      },
      onApprove: async (data) => {
        gig = await api(`/gigs/${gig.id}/authorize`, { body: { orderId: data.orderID } });
        toast('Money is on hold'); render();
      },
      onError: (err) => toast(err.message || 'PayPal error', true),
    }).render('#paypal-buttons');
  }).catch((e) => toast(e.message, true));
}

function waitingCard(changes) {
  const link = `${location.origin}/gig/${gig.id}/freelancer`;
  return `
    <div class="card">
      <h2>${changes ? 'Changes requested' : 'Money is on hold'}</h2>
      <p class="muted">${fmt(gig.amount, gig.currency)} is authorized on your PayPal, not charged. Authorization id <code>${esc(gig.paypal.authorizationId)}</code>${gig.paypal.expiresAt ? `, valid until ${when(gig.paypal.expiresAt)}` : ''}.</p>
      <label>Send this link to ${esc(gig.freelancerName)}</label>
      <div class="copy"><input readonly value="${link}" id="flink"><button class="ghost" id="copyBtn">Copy</button></div>
      <h3 style="margin-top:18px">The checklist (locked)</h3>
      ${critList()}
    </div>`;
}

function wireCopy() {
  const b = $('#copyBtn');
  if (b) b.onclick = () => { navigator.clipboard.writeText($('#flink').value); toast('Copied'); };
}

function deliverForm() {
  const cr = gig.changeRequest && gig.status === 'changes_requested' ? gig.changeRequest : null;
  const missing = cr ? gig.criteria.filter((c) => cr.missing.includes(c.id)) : [];
  return `
    ${cr ? `<div class="card" style="border-color:#ecd3a6">
      <h2>${esc(gig.clientName)} asked for changes</h2>
      ${cr.message ? `<p>"${esc(cr.message)}"</p>` : ''}
      ${missing.length ? `<p class="small muted">Still open:</p><ul>${missing.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}
    <div class="card">
      <h2>${fmt(gig.amount, gig.currency)} is on hold for you</h2>
      <p class="muted small">The client can't take it back while this is open, and you get paid for each checklist item you deliver, even if not everything is done.</p>
      ${critList()}
    </div>
    <div class="card">
      <h2>${cr ? 'Send the updated work' : 'Deliver the work'}</h2>
      <div class="field">
        <label for="content">Paste the work <span class="hint">(text, code, copy, a list of what you did)</span></label>
        <textarea id="content" rows="10"></textarea>
      </div>
      <div class="field">
        <label for="link">…or a link <span class="hint">(public page, gist, doc; the reviewer reads it)</span></label>
        <input id="link" type="url" placeholder="https://">
      </div>
      <div class="field">
        <label for="note">Anything the client should know?</label>
        <input id="note" maxlength="300" placeholder="Prices are placeholders, as discussed">
      </div>
      <button class="green" id="send">Submit for review</button>
    </div>`;
}

function wireDeliver() {
  $('#send').onclick = (e) => busy(e.target, async () => {
    gig = await api(`/gigs/${gig.id}/deliver`, { body: { content: $('#content').value, link: $('#link').value, note: $('#note').value } });
    toast('Submitted'); render();
  }, 'AI is reading it…');
}

function verdictRow(it, editable) {
  const c = gig.criteria.find((x) => x.id === it.id);
  return `
    <div class="verdict ${it.verdict}" data-id="${it.id}">
      <div class="head">
        <div><b>${esc(c.text)}</b> <span class="w small">${c.weight}%</span></div>
        ${editable
          ? `<select data-id="${it.id}" data-ai="${it.verdict}">${['met', 'partial', 'missing'].map((v) => `<option ${v === it.verdict ? 'selected' : ''}>${v}</option>`).join('')}</select>`
          : `<span class="tag ${it.verdict}">${it.verdict}</span>`}
      </div>
      ${it.evidence ? `<blockquote>"${esc(it.evidence)}"</blockquote>` : ''}
      ${it.note ? `<div class="small muted">${esc(it.note)}</div>` : ''}
      ${it.overridden ? `<div class="overridden">client changed this from "${it.aiVerdict}"</div>` : ''}
    </div>`;
}

function currentVerdicts() {
  const v = {};
  document.querySelectorAll('#verdicts select').forEach((s) => (v[s.dataset.id] = s.value));
  return v;
}

function deliveryCard(d) {
  return `
    <div class="card">
      <h3>What ${esc(gig.freelancerName)} delivered</h3>
      ${d.note ? `<p><i>"${esc(d.note)}"</i></p>` : ''}
      ${d.link ? `<p class="small">Link: <a href="${esc(d.link)}" target="_blank" rel="noopener">${esc(d.link)}</a>${d.fetchError ? ` <span style="color:var(--red)">(couldn't read it: ${esc(d.fetchError)})</span>` : ''}</p>` : ''}
      ${d.content ? `<pre style="white-space:pre-wrap;font:13.5px/1.5 var(--sans);background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:380px;overflow:auto">${esc(d.content)}</pre>` : ''}
    </div>`;
}

function receiptCard() {
  const s = gig.settlement;
  const refunded = gig.status === 'refunded';
  return `
    <div class="card">
      <h2>${refunded ? 'Hold cancelled, nothing was paid' : `${esc(gig.freelancerName)} got paid`}</h2>
      <div class="split"><div class="pay" style="width:${s.percent}%"></div><div class="back" style="width:${100 - s.percent}%"></div></div>
      <div class="legend"><span><b>${fmt(s.paid, gig.currency)}</b> paid (${s.percent}%)</span><span><b>${fmt(s.returned, gig.currency)}</b> released to ${esc(gig.clientName)}</span></div>
      ${s.message ? `<p>"${esc(s.message)}"</p>` : ''}
      <p class="small muted">PayPal ${refunded ? 'void' : `capture <code>${esc(s.paypal.captureId)}</code>, status ${esc(s.paypal.status)}`} · authorization <code>${esc(gig.paypal.authorizationId)}</code> · ${when(s.at)}</p>
      <h3 style="margin-top:16px">Final checklist</h3>
      ${s.items.map((it) => verdictRow(it, false)).join('')}
    </div>`;
}

loadConfig().then(load).catch((e) => { $('#app').innerHTML = `<p>${esc(e.message)}</p>`; });
