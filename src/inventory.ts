// MarketMaker — simulated inventory + P&L (per market, per match).
// All prices are probabilities in [0,1]. MM net position: + = long the outcome, - = short.
import { Market, MARKETS, ThreeWay } from './quoteModel';

export interface Position { q: number; avgP: number; realised: number; }
export type Book = Record<Market, Position>;

export function emptyBook(): Book {
  return { home: pos(), draw: pos(), away: pos() };
}
function pos(): Position { return { q: 0, avgP: 0, realised: 0 }; }

/**
 * Apply a fill to the MM position. `dq` is the signed change to the MM's position
 * (+ when the MM buys / goes longer, - when the MM sells / goes shorter), at `price`.
 * Weighted-average when increasing exposure; realise P&L when reducing/closing.
 */
export function applyFill(p: Position, dq: number, price: number): void {
  if (p.q === 0 || Math.sign(dq) === Math.sign(p.q)) {
    const newQ = p.q + dq;
    p.avgP = (p.q * p.avgP + dq * price) / newQ;
    p.q = newQ;
  } else {
    const closeQty = Math.min(Math.abs(dq), Math.abs(p.q));
    p.realised += closeQty * (price - p.avgP) * Math.sign(p.q); // long: gain if price>avg
    const prevSign = Math.sign(p.q);
    p.q += dq;
    if (p.q === 0) p.avgP = 0;
    else if (Math.sign(p.q) !== prevSign) p.avgP = price; // flipped past zero → new position
  }
}

export function unrealised(p: Position, fair: number): number {
  return p.q * (fair - p.avgP);
}

export interface Pnl { realised: number; unrealised: number; total: number; }
export function pnl(book: Book, fair: ThreeWay): Pnl {
  let realised = 0, unreal = 0;
  for (const m of MARKETS) { realised += book[m].realised; unreal += unrealised(book[m], fair[m]); }
  return { realised: round(realised), unrealised: round(unreal), total: round(realised + unreal) };
}

/** Settle all positions when the match ends. `winner` is the outcome that occurred. */
export function settle(book: Book, winner: Market): void {
  for (const m of MARKETS) {
    const r = m === winner ? 1 : 0;
    book[m].realised += book[m].q * (r - book[m].avgP);
    book[m].q = 0; book[m].avgP = 0;
  }
}

const round = (x: number) => Math.round(x * 10000) / 10000;
