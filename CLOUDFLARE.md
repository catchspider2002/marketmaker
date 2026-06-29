# MarketMaker — Cloudflare Deployment (as built)

**Track:** Trading Tools & Agents · **Subdomain:** `marketmaker.<domain>`
**Build spec:** see `SPEC.md`. Implementation notes: see `README.md`.

## Architecture decision: Durable Object polling, NOT a Container

The original plan used a Container running an always-on engine. **The shipped build does not use a Container.** A **QuoteRoom Durable Object** per fixture polls TxLINE odds + scores on an ~8s alarm, recomputes risk-adjusted quotes, runs the pause/widen risk timers, manages inventory, and broadcasts to dashboards over WebSocket. Single `wrangler deploy`, no Docker, no D1 — same Workers + TxLINE-client stack as the other projects.

The pause/widen timers (30s pause, 120s 2× spread after an event) are driven by stored timestamps applied on each recompute, so they don't need an always-on process.

## Component mapping (as built)

| Spec component | Cloudflare (shipped) |
|---|---|
| `probabilityModel.js` (overround removal) | `src/quoteModel.ts` `fairFromDecimals` / `fairFromPct` (uses TxODDS demargined `Pct`) |
| `spreadModel.js` (risk-adjusted bid/ask) | `src/quoteModel.ts` `baseHalfSpread` + `quoteMarket` (inventory skew) — judging centrepiece |
| `inventoryManager.js` | `src/inventory.ts` (weighted-avg positions, realised/unrealised, settle) |
| `riskController.js` (pause/widen on events) | `QuoteRoom` timestamps `pausedUntil` / `widenUntil`, set on goal/red |
| `quoteEngine.js` | `QuoteRoom.computeAndBroadcast()` on the alarm |
| `orderBook.js` + `POST /trade` | `QuoteRoom.trade()` via Worker `POST /api/trade/:fixtureId` |
| TxLINE client | `src/txline.ts` — auth + `fixtures/snapshot` + `odds/snapshot` + `scores/snapshot` |
| dashboard | `./public` via Workers `[assets]` (quote board, Chart.js spread history, inventory/P&L, trade terminal) |
| live feed | `GET /api/events/:fixtureId` WebSocket → QuoteRoom |

## Bindings (`wrangler.toml`, as shipped)

```toml
name = "marketmaker"
main = "src/worker.ts"
compatibility_date = "2026-01-01"

[assets]
directory = "./public"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "QUOTE_ROOM"
class_name = "QuoteRoom"

[[migrations]]
tag = "v1"
new_classes = ["QuoteRoom"]
```

Secret: `TXLINE_API_KEY` only (no `ANTHROPIC_API_KEY`, no Container, no D1).

## Deploy

```bash
npm install
wrangler login
wrangler secret put TXLINE_API_KEY
npm run deploy
```

## Verify / demo

- `GET /api/matches` → live World Cup fixtures (confirms auth).
- Open the dashboard → pick a match → **Set fair odds** → **Trade** → **Simulate goal** (quotes PAUSE then widen; spread chart spikes).
- `GET /api/quotes/:fixtureId` returns the clean JSON a desk would consume.

## Notes

- Positions live in the DO; persist across requests, reset on a fresh deploy.
- `getFairValue` falls back to last/known or a default if the odds line isn't found, so the dashboard always quotes; the demo `mock-odds`/`mock-event` drive it without a live match.
