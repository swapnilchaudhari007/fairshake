// The AI side of Fairshake. Two jobs:
//   1. turn a messy brief into a short checklist of things that can be checked
//   2. read the delivery and mark each checklist item met / partial / missing, with the line that proves it
//
// The model never picks the payout number. It only judges items; the math
// (weights x verdicts) happens in code where both sides can see it.
//
// Works with any OpenAI-compatible chat endpoint (Gemini, Groq, OpenRouter, Ollama, OpenAI).
// No key? We fall back to a dumb-but-honest keyword matcher and label it as such.

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const BASE_URL = (process.env.AI_BASE_URL || (GEMINI_KEY ? 'https://generativelanguage.googleapis.com/v1beta/openai' : '')).replace(/\/$/, '');
const API_KEY = process.env.AI_API_KEY || GEMINI_KEY;
const MODEL = process.env.AI_MODEL || (GEMINI_KEY ? 'gemini-2.5-flash' : 'gpt-4o-mini');
const ENABLED = Boolean(BASE_URL && (API_KEY || /localhost|127\.0\.0\.1/.test(BASE_URL)));

const VERDICT_SCORE = { met: 1, partial: 0.5, missing: 0 };

async function chatJSON(system, user) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI call failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  // some models wrap JSON in ```json fences even when asked not to
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI did not return JSON');
  return JSON.parse(m[0]);
}

// ---------- 1. brief -> checklist ----------

const DRAFT_PROMPT = `You help a client and a freelancer agree on what "done" means before money changes hands.
Read the brief and write 3 to 7 acceptance criteria.
Rules:
- each criterion must be something you could check by looking at the delivered work
- plain words, under 18 words each, no jargon
- weight = how much of the payment that item is worth; weights are integers and must add up to 100
- don't invent requirements the brief doesn't imply
Reply with JSON only: {"criteria":[{"text":"...","weight":30}]}`;

async function draftCriteria({ title, brief }) {
  if (!ENABLED) return { source: 'offline', criteria: offlineCriteria(brief) };
  try {
    const out = await chatJSON(DRAFT_PROMPT, `Title: ${title}\n\nBrief:\n${brief}`);
    return { source: MODEL, criteria: normalizeCriteria(out.criteria) };
  } catch (e) {
    console.warn('[ai] draft failed, using offline:', e.message);
    return { source: 'offline', criteria: offlineCriteria(brief), warning: e.message };
  }
}

function normalizeCriteria(list) {
  let items = (Array.isArray(list) ? list : [])
    .map((c) => ({ text: String(c.text || '').trim(), weight: Math.max(1, Math.round(Number(c.weight) || 0)) }))
    .filter((c) => c.text)
    .slice(0, 8);
  if (!items.length) throw new Error('empty criteria');
  return fixWeights(items).map((c, i) => ({ id: 'c' + (i + 1), ...c }));
}

// make weights add up to exactly 100 (models are bad at arithmetic)
function fixWeights(items) {
  const total = items.reduce((s, c) => s + c.weight, 0) || items.length;
  let out = items.map((c) => ({ ...c, weight: Math.max(1, Math.round((c.weight / total) * 100)) }));
  const diff = 100 - out.reduce((s, c) => s + c.weight, 0);
  const biggest = out.reduce((bi, c, i, arr) => (c.weight > arr[bi].weight ? i : bi), 0);
  out[biggest].weight += diff;
  return out;
}

function offlineCriteria(brief) {
  // if the brief has bullet points, those are the requirements
  const bullets = String(brief).split(/\n/).filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
  const src = bullets.length >= 2 ? bullets.join('\n') : String(brief);
  const parts = src
    .split(/\n|(?<=[.;!?])\s+|,\s*(?=and\s)/)
    .map((s) => s.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter((s) => s.split(/\s+/).length >= 3)
    .slice(0, 6);
  const items = (parts.length ? parts : ['Delivered work matches the brief']).map((t) => ({ text: t.slice(0, 140), weight: 1 }));
  return fixWeights(items).map((c, i) => ({ id: 'c' + (i + 1), ...c }));
}

// ---------- 2. delivery -> verdicts ----------

const REVIEW_PROMPT = `You are a fair, slightly strict reviewer sitting between a client and a freelancer.
You get a checklist and the freelancer's delivery. For EACH checklist item decide:
- "met": the delivery clearly does it
- "partial": started or mostly there, but something real is missing
- "missing": not there, or you can't find evidence
Quote a short piece of the delivery as evidence (max 25 words, copied exactly). If nothing to quote, use "".
Write "note" as one short sentence a non-technical client would understand.
Do not reward effort or nice wording, only what was actually delivered. Do not punish style choices the brief didn't ask about.
Then write "summary": 2 sentences, friendly, honest, addressed to both people.
Reply with JSON only:
{"items":[{"id":"c1","verdict":"met","evidence":"...","note":"..."}],"summary":"..."}`;

async function reviewDelivery({ title, brief, criteria, delivery }) {
  const body = deliveryText(delivery);
  let result;
  if (ENABLED) {
    try {
      const list = criteria.map((c) => `${c.id}. ${c.text} (worth ${c.weight}%)`).join('\n');
      const out = await chatJSON(
        REVIEW_PROMPT,
        `Job: ${title}\nOriginal brief:\n${brief}\n\nChecklist:\n${list}\n\nDELIVERY START\n${body.slice(0, 24000)}\nDELIVERY END`
      );
      result = { source: MODEL, items: out.items, summary: String(out.summary || '') };
    } catch (e) {
      console.warn('[ai] review failed, using offline:', e.message);
      result = { ...offlineReview(criteria, body), warning: e.message };
    }
  } else {
    result = offlineReview(criteria, body);
  }
  return finalize(criteria, result);
}

function deliveryText(d) {
  return [d.note && `Freelancer's note: ${d.note}`, d.content, d.fetched && `Content fetched from ${d.link}:\n${d.fetched}`]
    .filter(Boolean)
    .join('\n\n');
}

// line up the model's answer with our checklist, fill gaps, compute the suggestion
function finalize(criteria, result) {
  const byId = new Map((result.items || []).map((i) => [String(i.id), i]));
  const items = criteria.map((c) => {
    const r = byId.get(c.id) || {};
    const verdict = VERDICT_SCORE[r.verdict] !== undefined ? r.verdict : 'missing';
    return {
      id: c.id,
      verdict,
      evidence: String(r.evidence || '').slice(0, 220),
      note: String(r.note || (r.id ? '' : 'Reviewer did not return a verdict for this item.')).slice(0, 300),
    };
  });
  return {
    source: result.source,
    warning: result.warning,
    summary: result.summary,
    items,
    suggestedPercent: payoutPercent(criteria, items),
    reviewedAt: new Date().toISOString(),
  };
}

function payoutPercent(criteria, items) {
  const v = new Map(items.map((i) => [i.id, i.verdict]));
  const pct = criteria.reduce((s, c) => s + c.weight * (VERDICT_SCORE[v.get(c.id)] ?? 0), 0);
  return Math.round(pct * 10) / 10;
}

const STOP = new Set('the a an and or of to in on for with is are be by it this that as at from your you our we should must will can all each into has have use using make'.split(' '));
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));

function offlineReview(criteria, body) {
  const hay = new Set(words(body));
  const sentences = String(body).split(/(?<=[.!?\n])\s+/);
  const items = criteria.map((c) => {
    const keys = [...new Set(words(c.text))];
    const hits = keys.filter((k) => hay.has(k) || hay.has(k.replace(/s$/, '')));
    const ratio = keys.length ? hits.length / keys.length : 0;
    const verdict = ratio >= 0.6 ? 'met' : ratio >= 0.3 ? 'partial' : 'missing';
    const ev = sentences.find((s) => hits.some((h) => s.toLowerCase().includes(h))) || '';
    return {
      id: c.id,
      verdict,
      evidence: ev.trim().split(/\s+/).slice(0, 25).join(' '),
      note: `Keyword match ${hits.length}/${keys.length}. Offline check, please eyeball this one.`,
    };
  });
  return {
    source: 'offline',
    items,
    summary: 'This is the offline keyword check, not a real review. Add an AI key in .env for proper verdicts.',
  };
}

module.exports = {
  enabled: ENABLED,
  model: ENABLED ? MODEL : 'offline',
  draftCriteria,
  reviewDelivery,
  payoutPercent,
  fixWeights,
  VERDICT_SCORE,
};
