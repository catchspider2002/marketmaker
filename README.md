# MarketMaker - In-Play Market Maker Bot

An autonomous market maker that quotes continuous bid/ask prices on in-play World Cup outcomes, adjusts spreads in real time on risk, manages a simulated inventory + P&L, and exposes a live trade API. Submitted to the Superteam × TxODDS World Cup Hackathon - Trading Tools & Agents track.

**Stack:** Cloudflare Workers + **Durable Objects** (odds/score polling + WebSocket fan-out) + static dashboard. **No Container, no Claude API - the decision logic is pure, deterministic math.**

- **Live:** https://marketmaker.wc26hackathon.com
- **GitHub:** https://github.com/catchspider2002/marketmaker
- **Demo video:** _add link_
- **TxLINE endpoints used:** `POST /auth/guest/start`, `GET /api/fixtures/snapshot`, `GET /api/odds/snapshot/{fixtureId}`, `GET /api/scores/snapshot/{fixtureId}`

---

## What it does

- **Fair value** (`src/quoteModel.ts` + `txline.getFairValue`): takes TxODDS demargined `Pct` for the 3-way market (overround removed) as the mid-price.
- **Spread model** (`src/quoteModel.ts`): a named, commented formula. Base 2.5pp half-spread, widened by recent events, late-game, extra time/penalties, sharp movement, and **inventory skew** (widen the side that increases exposure). Capped at 15pp.
- **Risk controller**: on a goal / red / penalty it **pauses quoting for 30s** (pull) then quotes at **2× spread for 120s** - the behaviour that separates a production MM from a naive one.
- **Inventory + P&L** (`src/inventory.ts`): weighted-average positions, realised on close, unrealised marked to fair value, settled at full time.
- **Simulated order book**: `POST /api/trade/:fixtureId` fills against the live quote (buy at ask / sell at bid), updates inventory, and reprices on skew.

The judging centrepieces are `quoteModel.ts` and `inventory.ts` - kept small, deterministic, and fully commented.

## Architecture (no Container)

A **QuoteRoom Durable Object** per fixture polls TxLINE odds + scores on an ~8s alarm, recomputes quotes, runs the pause/widen timers, and broadcasts to dashboards over WebSocket. Single `wrangler deploy`, no Docker, no D1.

## Setup & deploy

```bash
npm install
wrangler login
wrangler secret put TXLINE_API_KEY      # your txoracle_api_... token
npm run deploy
```

## Demo (no live match needed)

1. Open the dashboard, pick a match.
2. **Set fair odds** (decimal) in Demo controls → quotes appear around the demargined mid. (Demo controls are admin-only - open the dashboard with `?admin=YOUR_ADMIN_KEY` to reveal them; normal visitors don't see them.)
3. Use the **Trade terminal** - buy 50 Home, watch the position fill and the Home ask widen from inventory skew.
4. Hit **Simulate goal** - quotes go PAUSED for 30s, then return at 2× spread; the spread-history chart spikes.
5. `POST /api/quotes/:fixtureId` in the browser shows the clean JSON a trading desk would consume.

For a real in-play match, the DO drives everything automatically from TxLINE odds + scores.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/matches` | World Cup fixtures |
| GET | `/api/quotes/:fixtureId` | current quotes + inventory + P&L (REST) |
| WS | `/api/events/:fixtureId` | live quote stream |
| POST | `/api/trade/:fixtureId` | `{ market, side, size }` → fill |
| POST | `/api/mock-event/:fixtureId` | `{ type:"goal" }` → pause + widen (demo) - **requires `X-Admin-Key: $ADMIN_KEY`** |
| POST | `/api/mock-odds/:fixtureId` | `{ home, draw, away }` fair probs (demo) - **requires `X-Admin-Key: $ADMIN_KEY`** |

## Notes / limitations (hackathon scope)

- Positions are in-memory in the Durable Object; they persist across requests but a fresh deploy resets them.
- `minutesRemaining` is approximated from match phase (no precise clock in the snapshot).
- Settlement uses the final 3-way result (home/draw/away); a draw settles both win markets to 0.
- A Solflare/Phantom/Backpack connect can be added to the dashboard for the Solana sign-up requirement.
