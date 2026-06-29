# MarketMaker — In-Play Market Maker Bot
## Build Spec for Claude Code

---

## What we're building

An autonomous market maker bot that quotes continuous buy and sell prices on in-play World Cup outcomes, adjusting its spreads and mid-prices in real time as TxLINE data flows in. The bot manages a simulated inventory, tracks P&L across the tournament, and exposes a clean API that a real operator could plug into. The emphasis is on the decision logic being clean, mathematically defensible, and production-ready — not on on-chain settlement.

Submitted to the **Superteam × TxODDS World Cup Hackathon** under the **Trading Agents** track.

**Hackathon deadline:** July 19, 2026 (23:59 UTC)  
**Required:** running agent (live or devnet), demo video, public GitHub repo, working dashboard/API endpoint

---

## What a market maker does — put this in your README

A market maker continuously quotes a bid (buy) price and an ask (sell) price on an outcome. The spread between them is the market maker's theoretical edge. When someone buys at the ask, the MM is short that outcome. When someone sells at the bid, the MM is long. The MM profits if the spread is wide enough to cover the risk of holding inventory in an outcome that later resolves against them. In-play market making is harder than pre-match because probabilities shift violently on match events — a goal can move a market 20pp in seconds. The bot must widen spreads or pull quotes entirely when risk is elevated.

---

## Architecture overview

```
TxLINE SSE Stream
       │
       ▼
Market Maker Engine (core bot)
  ├── Probability model: converts TxLINE odds → fair value mid-price
  ├── Spread model: calculates bid/ask around mid based on risk factors
  ├── Inventory manager: tracks simulated positions + P&L
  ├── Quote publisher: exposes current quotes via REST API
  └── Risk controller: widens spreads or pulls quotes on high-risk events
       │
       ▼
Simulated Order Book (in-memory)
  ├── Accepts simulated trades against the bot's quotes
  ├── Updates inventory on each fill
  └── Tracks realised + unrealised P&L
       │
       ▼
Dashboard + API
  ├── Live quote feed per match + market
  ├── Inventory + P&L tracker
  ├── Spread history chart
  └── Public REST API: GET /quotes/:matchId
```

---

## Project structure

```
marketmaker/
├── bot/
│   ├── index.js              # Entry point — starts SSE listener + engine
│   ├── txline.js             # TxLINE SSE client
│   ├── probabilityModel.js   # Fair value calculation from TxLINE odds
│   ├── spreadModel.js        # Bid/ask spread calculation
│   ├── inventoryManager.js   # Position tracking + P&L
│   ├── riskController.js     # Event-driven risk management
│   ├── quoteEngine.js        # Orchestrates all above → outputs quotes
│   └── orderBook.js          # Simulated order book (accepts test trades)
├── backend/
│   ├── server.js             # Express API
│   └── routes/
│       ├── quotes.js         # GET /quotes/:matchId — current live quotes
│       ├── inventory.js      # GET /inventory — current positions + P&L
│       ├── history.js        # GET /history/:matchId — quote history
│       └── trade.js          # POST /trade — submit simulated trade against quotes
├── frontend/
│   ├── index.html            # Dashboard
│   ├── app.js
│   └── styles.css
├── db/
│   ├── quotes-log.json       # Historical quotes for chart + analysis
│   └── trades-log.json       # All simulated fills
├── .env.example
├── package.json
└── README.md
```

---

## Core bot logic — detailed spec

### Step 1: Fair value model (`probabilityModel.js`)

Convert TxLINE consensus odds to a fair value mid-price (implied probability), removing the overround.

```js
/**
 * TxLINE odds include a margin (overround). Remove it to get fair probabilities.
 * Standard Shin method for three-way markets (home / draw / away).
 */
function calculateFairValue(rawOdds) {
  const { homeWin, draw, awayWin } = rawOdds

  // Step 1: raw implied probabilities (sum > 1 due to overround)
  const rawHome  = 1 / homeWin.decimal
  const rawDraw  = 1 / draw.decimal
  const rawAway  = 1 / awayWin.decimal
  const overround = rawHome + rawDraw + rawAway

  // Step 2: normalise to remove overround (simple proportional method)
  return {
    homeWin: Math.round((rawHome / overround) * 10000) / 10000,
    draw:    Math.round((rawDraw  / overround) * 10000) / 10000,
    awayWin: Math.round((rawAway  / overround) * 10000) / 10000
  }
}
```

This fair value is the mid-price the bot quotes around. It updates every time TxLINE pushes new odds.

### Step 2: Spread model (`spreadModel.js`)

Calculate bid/ask spread around the mid-price. Spread widens with:
- Match volatility (more events recently = wider spread)
- Inventory skew (if long on an outcome, widen ask to reduce further exposure)
- Time to key decision points (last 10 mins, extra time)
- Recent sharp movement detected in TxLINE odds

```js
const BASE_SPREAD = 0.025        // 2.5pp base spread on each side
const MAX_SPREAD  = 0.15         // 15pp max spread (very high risk)
const PULL_THRESHOLD = 0.20      // pull quotes entirely above this risk score

function calculateSpread(fairValue, riskFactors) {
  const {
    recentEventCount,     // events in last 5 mins (0–5+)
    inventorySkew,        // how far long/short we are (-1 to +1)
    minutesRemaining,     // 90 - currentMinute
    sharpMovementActive,  // bool: large TxLINE move in last 60s
    matchStatus           // 'normal' | 'extra_time' | 'penalties'
  } = riskFactors

  let spread = BASE_SPREAD

  // Widen for recent events (each event in last 5 mins adds 0.5pp)
  spread += Math.min(recentEventCount * 0.005, 0.03)

  // Widen for inventory skew (max +5pp at full skew)
  spread += Math.abs(inventorySkew) * 0.05

  // Widen in final 10 minutes
  if (minutesRemaining <= 10) spread += 0.02

  // Widen significantly during extra time / penalties
  if (matchStatus === 'extra_time') spread += 0.04
  if (matchStatus === 'penalties')  spread += 0.08

  // Widen on sharp movement
  if (sharpMovementActive) spread += 0.03

  spread = Math.min(spread, MAX_SPREAD)

  return {
    bid: Math.round((fairValue - spread) * 10000) / 10000,
    ask: Math.round((fairValue + spread) * 10000) / 10000,
    spread: Math.round(spread * 2 * 10000) / 10000,   // total spread
    riskScore: spread / MAX_SPREAD                     // 0–1
  }
}
```

### Step 3: Inventory manager (`inventoryManager.js`)

Tracks simulated positions and P&L. Each simulated trade updates inventory.

```js
// Position per market per match
{
  matchId: string,
  market: 'homeWin' | 'draw' | 'awayWin',
  netPosition: number,        // + = long (net sold ask), - = short (net bought bid)
  averagePrice: number,       // weighted average fill price
  realisedPnl: number,        // P&L from closed positions
  unrealisedPnl: number,      // P&L at current fair value
  tradeCount: number
}
```

Post-match settlement: when `full_time` fires, resolve all open positions:
- Long position in winning outcome: `realisedPnl += netPosition * (1 - averagePrice)`
- Long position in losing outcome: `realisedPnl -= netPosition * averagePrice`
- Short positions: reverse of above

Track aggregate P&L across the tournament in a summary record.

### Step 4: Risk controller (`riskController.js`)

Listens to TxLINE SSE for match events. On each significant event:

```js
function handleMatchEvent(event, quoteEngine) {
  switch (event.type) {
    case 'goal':
    case 'red_card':
    case 'penalty_awarded':
      // Temporarily pause quoting for 30 seconds
      quoteEngine.pauseQuoting(event.matchId, 30000)
      // Resume with wider spreads
      quoteEngine.setSpreadMultiplier(event.matchId, 2.0, duration=120000)
      break

    case 'var_review':
      // Pause until VAR decision resolves
      quoteEngine.pauseQuoting(event.matchId, 'until_var_resolved')
      break

    case 'full_time':
      // Pull all quotes for this match
      quoteEngine.pullAllQuotes(event.matchId)
      // Trigger settlement
      inventoryManager.settle(event.matchId, event.outcome)
      break
  }
}
```

The pause-on-goal behaviour is critical — it's what real market makers do. Quoting immediately after a goal before the odds stabilise is how you get adversely selected.

### Step 5: Quote engine (`quoteEngine.js`)

Orchestrates the above. On each TxLINE odds update:

1. Calculate fair value (`probabilityModel.js`)
2. Get risk factors from `riskController` + `inventoryManager`
3. Calculate spread (`spreadModel.js`)
4. If `riskScore >= PULL_THRESHOLD`: publish `{ status: 'pulled', reason }` — no quote
5. Otherwise: publish bid/ask for each market
6. Log to `quotes-log.json`
7. Broadcast via SSE to connected dashboard clients

Quote output structure:
```js
{
  matchId: string,
  updatedAt: ISO timestamp,
  matchMinute: number,
  markets: {
    homeWin: {
      fairValue: 0.571,
      bid: 0.548,
      ask: 0.594,
      spread: 0.046,
      status: 'live'    // 'live' | 'pulled' | 'paused'
    },
    draw:    { ... },
    awayWin: { ... }
  },
  riskScore: 0.32,
  spreadMultiplier: 1.0
}
```

---

## Simulated order book (`orderBook.js`)

Allows test trades against the bot's quotes. Exposed via `POST /trade`.

```js
// Trade request
{
  matchId: string,
  market: 'homeWin' | 'draw' | 'awayWin',
  side: 'buy' | 'sell',
  size: number    // in USDC equivalent (1–100)
}

// Trade response
{
  filled: true | false,
  fillPrice: number,
  reason: string    // if not filled: 'quotes_pulled' | 'size_too_large' | 'spread_too_wide'
}
```

Max single trade size: 100 USDC equivalent. Reject trades larger than available inventory headroom.

This endpoint is what judges use to interact with the bot directly — it proves the system is actually operational, not just a dashboard.

---

## Dashboard (`frontend/index.html`)

### 1. Live quote board
One row per active match, three columns (home / draw / away):

```
Brazil vs France  |  67'  |  Risk: Medium

             HOME WIN      DRAW       AWAY WIN
Fair value:   57.1%        27.8%      22.2%
Bid:          54.8%        25.5%      20.0%
Ask:          59.4%        30.1%      24.4%
Spread:        4.6pp        4.6pp      4.4pp
Status:       LIVE          LIVE       LIVE
```

Colour the Status cell: green=LIVE, amber=PAUSED, red=PULLED.

### 2. Spread history chart
Line chart: spread width over time for each market of the selected match.
Annotations: vertical lines at match events (goal, red card etc.)
Shows visually how spread widens on events and narrows as market settles.

### 3. Inventory + P&L panel
Table: current positions across all markets + matches

| Match | Market | Position | Avg Price | Fair Value | Unrealised P&L |
|---|---|---|---|---|---|
| BRA v FRA | Home win | +12.5 | 0.552 | 0.571 | +0.24 USDC |

Running totals: realised P&L + unrealised P&L + total.

### 4. Trade terminal (for judges)
Simple form: pick match, pick market, pick buy/sell, enter size, hit Execute.
Shows fill result inline. Proves `POST /trade` is live.

---

## Deployment

- **Bot + backend:** Railway or Fly.io — persistent process required for SSE listener
- **Frontend:** Vercel or Netlify
- The `POST /trade` endpoint must be publicly accessible for judges to test

---

## Environment variables (`.env`)

```
TXLINE_API_KEY=your_txline_key
TXLINE_SSE_URL=https://txline.txodds.com/stream
TXLINE_BASE_URL=https://txline.txodds.com
PORT=3001
```

No Claude API needed for the core bot — the math is deterministic. Optionally add Claude to generate a plain-English risk summary on the dashboard, but don't block on it.

---

## Demo video plan (max 5 minutes)

1. **0:00–0:30** — Open the dashboard. Show the live quote board mid-match. Explain bid/ask/spread in one sentence.
2. **0:30–1:30** — Open `spreadModel.js`. Walk through the spread formula — point to each risk factor constant. Emphasise: "mathematically defensible, every parameter is named and commented."
3. **1:30–2:30** — Simulate a goal firing (use a mock event endpoint). Watch the dashboard: quotes go PAUSED for 30 seconds, then return with wider spreads. Show the spread history chart spike.
4. **2:30–3:30** — Use the trade terminal on the dashboard. Submit a buy trade. Watch the inventory panel update. Submit another buy — show the spread widening on that market due to inventory skew.
5. **3:30–4:00** — Show the P&L panel. Simulate full_time event. Watch positions settle. Show final realised P&L.
6. **4:00–4:30** — Hit `GET /quotes/:matchId` directly in the browser. Show the clean JSON response. "A trading team plugs this API into their front-end. Done."
7. **4:30–5:00** — Wrap: "Continuous quotes. Risk-adjusted spreads. Inventory management. Fully autonomous. Production-ready API."

---

## Submission checklist

- [ ] Bot running and updating quotes on TxLINE odds pushes
- [ ] Spread model responding to match events (pause + widen on goal/red card)
- [ ] Inventory manager tracking positions
- [ ] Post-match settlement working
- [ ] `POST /trade` endpoint live and functional for judges
- [ ] Dashboard: quote board + spread chart + inventory panel + trade terminal
- [ ] GitHub repo public — `spreadModel.js` and `probabilityModel.js` especially clean
- [ ] Demo video uploaded
- [ ] TxLINE endpoints listed in submission form
- [ ] API feedback prepared

---

## TxLINE resources

- Quickstart: https://txline.txodds.com/documentation/quickstart
- World Cup docs: https://txline.txodds.com/documentation/worldcup
- Support: Discord and Telegram
- Data fees waived until July 19, 2026

---

## Key decisions / notes for Claude Code

- **No Claude API required** — the bot is pure math. The probability model and spread model are deterministic algorithms. This actually strengthens the submission: "clean, deterministic, well-documented" is explicitly what the judging criteria asks for.
- **Build `mockStream.js` first** — you need to simulate goals, red cards, and odds movements to test pause/widen behaviour. Don't wait for a live match. Fire mock events on a timer.
- **Add `POST /mock-event` endpoint** for the demo — lets you trigger a goal or red card on demand during the video to show the spread response live.
- **The overround removal is important** — never quote around the raw TxLINE implied probabilities directly. Always normalise first. Raw implied probs sum to > 100% because of the bookmaker margin. Quoting around the unnormalised number would mean your mid-price is wrong.
- **The pause-on-goal behaviour is the most important risk feature** — explain it explicitly in the README and the demo. It's what separates a naive bot from a production-ready one.
- **Inventory skew spread adjustment is the second key feature** — if the bot is heavily long on Brazil winning, it should widen its ask on that market to slow further accumulation. This is standard MM practice and makes the spread model genuinely defensible.
- **Keep positions in memory** — no database needed. On restart, positions reset to zero. Note this in the README as a known limitation.
- **The trade terminal is essential for the demo** — judges need to interact with the bot, not just observe it. Make `POST /trade` work and expose it through the dashboard UI.
- **Spread history chart is the visual centrepiece** — the spike in spread around a goal event is the clearest proof the bot is risk-aware. Make it prominent and well-labelled.
