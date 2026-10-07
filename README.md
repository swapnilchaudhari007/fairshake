# Fairshake

**Hold the money. Check the work. Pay for what was delivered.**

Fairshake is a small payment tool for one-off freelance jobs. The client's money is put on hold with a PayPal authorization, an AI reviewer checks the delivered work against the brief item by item, and then PayPal captures only the share that was actually earned. Whatever wasn't delivered goes back to the client automatically.

Built for the PayPal AI Hackathon 2026.

## Why I built this

I've been on both sides of small freelance jobs. As the person paying, you either pay 50% upfront and hope, or you pay at the end and the freelancer has to trust you. As the freelancer, you finish 80% of a job, the client is unhappy about one thing, and suddenly the whole payment is "on hold" over email for two weeks.

The problem isn't really payment. It's that nobody wrote down what "done" means, and when it goes wrong the only options are pay everything or pay nothing.

PayPal already has the right primitive for this: you can **authorize** a payment and **capture part of it later**, with the rest released back to the buyer. What was missing was a fair way to decide *how much* to capture. That's the part the AI does.

## How it works

1. **Agree.** The client pastes a brief written the normal way ("I need a landing page for my bakery, about section, menu, WhatsApp ordering..."). The AI turns it into 3 to 7 checkable items, each worth a share of the budget. The client can edit everything.
2. **Hold.** The client approves the payment with PayPal. The order is created with `intent: AUTHORIZE`, so nothing is charged, but the freelancer can see the money is really there. The checklist is locked from this point.
3. **Deliver.** The freelancer pastes the work, or a link to it. The AI reads it and marks each item `met`, `partial` or `missing`, and quotes the exact line from the delivery that backs up each verdict.
4. **Settle.** The client sees the suggested split and can override any line (overrides are logged in the history both sides see). On release, Fairshake captures the earned amount on the authorization with `final_capture: true`, which tells PayPal to release the remainder to the buyer. If nothing was delivered, the authorization is voided.

The client can also send it back with "ask for changes" instead. The unmet items are sent along, and the freelancer resubmits against the same hold.

### The AI never decides the money

This was a deliberate choice. The model only judges each checklist item and has to show evidence. The payout is plain arithmetic in code (`sum of weight x score`, where met = 1, partial = 0.5, missing = 0), the client confirms it, and every change is in the timeline. I didn't want a black box that says "pay 63%".

## PayPal pieces used

| What | API | Where |
|---|---|---|
| OAuth client credentials | `POST /v1/oauth2/token` | `lib/paypal.js` |
| Create order with `intent: AUTHORIZE`, `payee` set to the freelancer | `POST /v2/checkout/orders` | `lib/paypal.js` `createOrder` |
| Buyer approval | PayPal JS SDK Buttons (`intent=authorize`) | `public/gig.js` `mountPayPal` |
| Authorize the approved order | `POST /v2/checkout/orders/{id}/authorize` | `authorizeOrder` |
| Partial capture, release the rest | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: true` | `captureAuthorization` |
| Cancel when nothing was delivered | `POST /v2/payments/authorizations/{id}/void` | `voidAuthorization` |

Every money-moving call sends a `PayPal-Request-Id` so a double click or a retry can't capture twice.

## AI pieces used

- **Brief to checklist:** prompt in `lib/ai.js` (`DRAFT_PROMPT`). Returns JSON, weights are re-normalised in code to add up to exactly 100.
- **Delivery review:** `REVIEW_PROMPT`. One verdict per item, a short quote as evidence, a one-line note in plain English, and a two-sentence summary for both people.
- Works with any OpenAI-compatible endpoint. I used **Google Gemini 2.5 Flash** (free tier) through its OpenAI-compatible URL. Groq, OpenRouter, Ollama or OpenAI also work by changing three env vars.
- If no key is set, it falls back to a very basic keyword matcher, clearly labelled as such in the UI, so the app still runs.

## Run it

Needs Node 18 or newer.

```bash
git clone https://github.com/Swapnilchaudhari007/fairshake.git
cd fairshake
npm install
cp .env.example .env     # then fill in the keys, see below
npm start
```

Open http://localhost:3000

### Keys

- **PayPal sandbox:** go to [developer.paypal.com](https://developer.paypal.com), Apps & Credentials, Sandbox, create an app, and copy the client ID and secret into `.env`. Log in at checkout with one of your sandbox *personal* accounts (Testing Tools > Sandbox Accounts).
- **Freelancer email (optional):** put a sandbox *business* account email in the "Freelancer's PayPal email" field and the captured money lands directly in that account. Leave it empty and it goes to your app's own sandbox account.
- **AI:** get a free key at [aistudio.google.com](https://aistudio.google.com) and set `GEMINI_API_KEY`.

No keys at all? It still starts, using a fake PayPal and the offline checker, with a banner telling you so. Useful for a quick look, but the real thing is the sandbox flow.

### Try the whole flow in two minutes

1. On the home page click **Fill with an example**, then **Draft the checklist**.
2. Tweak the checklist if you want, then pay with the PayPal button (sandbox buyer account).
3. Click **Freelancer view**, paste some work, leave one thing out on purpose, submit.
4. Go back to **Client view**. You'll see the verdicts with quotes, and the split bar. Change a verdict and watch the amount move.
5. Release. In the sandbox buyer account you'll see the authorization with a partial capture and the rest released.

### Tests

```bash
npm test
```

Runs the whole lifecycle (create, edit checklist, authorize, deliver, request changes, redeliver, partial capture, and a zero-percent void) against the mock PayPal.

## Project layout

```
server.js          express routes, the gig state machine
lib/paypal.js      Orders v2 + Payments v2 calls, and a mock for offline use
lib/ai.js          the two prompts, JSON handling, payout math, offline fallback
lib/store.js       JSON file storage (data/gigs.json)
public/            plain HTML/CSS/JS, no build step
test/flow.test.js  end-to-end test
```

Gig states: `draft -> funded -> delivered -> settled` (or `refunded`), with `delivered -> changes_requested -> delivered` as the loop.

## Things I know are missing

- **Real accounts.** Right now there are just two links, one per side. Proper login is the obvious next step.
- **Authorization window.** PayPal authorizations are honoured for 3 days and valid for 29. For longer jobs Fairshake would need to reauthorize, or split the job into milestones with one authorization each. Milestones are what I'd build next.
- **Disputes.** If the freelancer disagrees with the client's final call, today they can only say so in the next note. Hooking into PayPal's disputes flow would close that gap.
- **Files.** The reviewer reads text and web pages. Images and PDFs would need a vision model.

## License

MIT, see [LICENSE](LICENSE).
