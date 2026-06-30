# MarketMaker - Submission Checklist

Track: **Trading Tools & Agents** (Superteam × TxODDS World Cup Hackathon)
Live: https://marketmaker.catchspider2002.workers.dev · Repo: https://github.com/catchspider2002/marketmaker

## ✅ Done

- [x] Deterministic quote model: overround removal + risk-adjusted spread (named/commented) - `quoteModel.ts`
- [x] Inventory + P&L: weighted-avg positions, realised/unrealised, settlement - `inventory.ts`
- [x] Risk controller: pause 30s + widen 2× for 120s on goal/red/penalty
- [x] QuoteRoom Durable Object: ~8s odds/score poll + WebSocket fan-out (no Container)
- [x] TxLINE client: auth + fixtures + odds (demargined Pct) + scores
- [x] Simulated order book: `POST /api/trade` (buy@ask / sell@bid, inventory skew reprices)
- [x] Dashboard: quote board, spread-history chart (Chart.js), inventory/P&L, trade terminal
- [x] Demo drivers: `POST /api/mock-event`, `POST /api/mock-odds`
- [x] Config (wrangler DO + assets), README, CLOUDFLARE.md (as-built)

## ⏳ Before submitting

- [ ] **Deploy**: `wrangler secret put TXLINE_API_KEY` → `npm run deploy` (then confirm the live URL above)
- [ ] **Verify**: `GET /api/matches` returns fixtures; dashboard quotes after "Set fair odds"; "Simulate goal" pauses then widens
- [ ] **Record demo video** (≤5 min): walk `quoteModel.ts`/`inventory.ts`, set odds, trade, simulate a goal (spread chart spike), show `GET /api/quotes/:id` JSON
- [ ] **Add demo video link** to README + submission form
- [ ] **Push final code to GitHub** - confirm latest commit; verify `.dev.vars` is NOT committed
- [ ] **Fill submission form**: live URL, GitHub URL, video URL, TxLINE endpoints used, API feedback
- [ ] Attach custom domain `marketmaker.<domain>` (optional)

## 💡 Optional polish / known limitations

- [ ] Solflare/Phantom/Backpack connect on the dashboard (Solana sign-up requirement)
- [ ] Precise match clock for `minutesRemaining` (currently approximated from phase)
- [ ] Persist positions across deploys (currently reset on redeploy)
- [ ] Tune spread constants against real in-play odds frequency
- [ ] Verify the odds `PriceNames`/`Pct` shape against a live match (parser has a safe fallback)
