# Daily AI safeguard

All AI calls in this inbox (chat, auto-drafts, injection scans and draft proofreading)
go through `createBudgetedAI`. A single SQLite Durable Object reserves a conservative
cost before each provider call. The shared cap is 8,000 reserved units per UTC day,
across both domains and all mailboxes. Reservations are never refunded, including
errors, SDK retries, interrupted streams and unused output capacity.

The actual Cloudflare allowance remains 10,000 neurons per account per UTC day.
This application guard cannot control other Workers, dashboard playground use or
other applications in that account. It is not a Cloudflare billing cap.

Chat uses a maximum of 1,024 output tokens; proofreading retains its existing
4,096-token maximum and preserves original text if output is truncated. We count
two input tokens per UTF-8 byte of the entire serialized request, plus 8,192 template
tokens and 256 per message. Input and output rates are rounded up to 0.1 and 0.5
neurons/token respectively, above the allowlisted models' prices checked on
2026-09-24. This intentionally exhausts the app budget earlier than Cloudflare's
actual metering. Oversized/multimodal requests, unknown models, unsupported options,
invalid ledgers and storage failures block AI. Do not add models without reviewing
tokenization, output limits and current pricing. Provider pricing or accounting
changes require re-review; this is a conservative software guard, not a provider
guarantee of zero charges.

No new calls start in the final 15 minutes of the UTC day, to reduce billing-boundary
risk. There is no reliable ledger for calls made before deployment, so the first
tracked day is 2026-09-25 UTC; earlier calls are blocked. This starts at 5:00 AM
Pakistan on September 25. Existing emails and drafts remain intact. Reaching the
budget skips auto-drafting; manual sending preserves the user's text if optional
AI proofreading cannot run. The security scanner still fails closed for auto-drafts.

`GET /api/v1/ai-budget` is behind the app's existing Cloudflare Access policy and
returns only budget counters. The panel shows these conservative reservations,
not measured Cloudflare usage. There is no reset or refund API. The raw AI binding
is named `AI_RAW`; only the guarded adapter calls it.

Validation: `npm test` checks request bounds, exhaustion, daily rollover, first-day
blocking, fail-closed behavior, streaming, manual-email preservation and concurrent
reservations/persistence against a real local Durable Object. `npm run typecheck`
and `npm run build` validate integration.
