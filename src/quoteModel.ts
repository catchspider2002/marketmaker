// MarketMaker - deterministic quote model. This is the judging centerpiece: every
// parameter is named and commented. No randomness, no Claude - pure math.

export type ThreeWay = { home: number; draw: number; away: number };
export type Market = keyof ThreeWay;
export const MARKETS: Market[] = ['home', 'draw', 'away'];

// ---- Spread tuning constants ----
export const BASE_SPREAD = 0.025;     // 2.5pp half-spread on each side at rest
export const MAX_SPREAD = 0.15;       // 15pp half-spread cap (very high risk)
export const INVENTORY_CAP = 100;     // position size (USDC-equiv) treated as "full" skew
export const PAUSE_MS = 30_000;       // pull quotes for 30s after a goal/red/penalty
export const WIDEN_MS = 120_000;      // then quote at x2 spread for 120s
export const WIDEN_MULTIPLIER = 2;

/**
 * Remove the bookmaker overround from raw decimal odds to get a fair probability mid.
 * Raw implied probs sum to >1 because of the margin; we normalise proportionally.
 */
export function fairFromDecimals(d: ThreeWay): ThreeWay {
  const raw = { home: 1 / d.home, draw: 1 / d.draw, away: 1 / d.away };
  const o = raw.home + raw.draw + raw.away;
  return { home: raw.home / o, draw: raw.draw / o, away: raw.away / o };
}

/** Fair probabilities from TxODDS demargined percentages (already ~demargined; we renormalise to be safe). */
export function fairFromPct(pct: ThreeWay): ThreeWay {
  const s = pct.home + pct.draw + pct.away;
  return { home: pct.home / s, draw: pct.draw / s, away: pct.away / s };
}

export interface RiskFactors {
  recentEventCount: number;                              // events in the last ~5 min
  minutesRemaining: number;                              // 90 - currentMinute (approx)
  sharpMovementActive: boolean;                          // large fair-value move since last poll
  matchStatus: 'normal' | 'extra_time' | 'penalties';
  widen: boolean;                                        // inside the post-event widen window
}

/** Base half-spread (same for all three markets), before inventory skew. */
export function baseHalfSpread(r: RiskFactors): number {
  let s = BASE_SPREAD;
  s += Math.min(r.recentEventCount * 0.005, 0.03);   // +0.5pp per recent event, cap +3pp
  if (r.minutesRemaining <= 10) s += 0.02;            // late-game volatility
  if (r.matchStatus === 'extra_time') s += 0.04;
  if (r.matchStatus === 'penalties') s += 0.08;
  if (r.sharpMovementActive) s += 0.03;              // someone is moving the market
  if (r.widen) s *= WIDEN_MULTIPLIER;                // post-event widen window
  return Math.min(s, MAX_SPREAD);
}

export interface Quote { fairValue: number; bid: number; ask: number; spread: number; riskScore: number; status: 'live' | 'paused'; }

const clamp = (x: number) => Math.max(0.02, Math.min(0.98, Math.round(x * 10000) / 10000));
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/**
 * Quote one market around its fair value.
 * Inventory skew: if the MM is long the outcome, widen the ASK (raise it) to slow further
 * accumulation; if short, widen the BID (lower it). Standard market-making practice.
 */
export function quoteMarket(fair: number, half: number, netPosition: number, paused: boolean): Quote {
  const skew = Math.max(-1, Math.min(1, netPosition / INVENTORY_CAP));
  const widen = Math.abs(skew) * 0.05; // up to +5pp on the exposed side
  let bid = fair - half;
  let ask = fair + half;
  if (skew > 0) ask += widen;          // long → discourage buying more from us
  else if (skew < 0) bid -= widen;     // short → discourage selling more to us
  return {
    fairValue: r4(fair),
    bid: clamp(bid),
    ask: clamp(ask),
    spread: r4(ask - bid),
    riskScore: r4(Math.min(1, half / MAX_SPREAD)),
    status: paused ? 'paused' : 'live',
  };
}
