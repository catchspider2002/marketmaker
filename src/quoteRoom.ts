// MarketMaker - QuoteRoom Durable Object. One per fixture.
// Alarm (~8s) polls TxLINE odds (fair value) + scores (events), recomputes risk-adjusted
// quotes, runs the pause/widen risk timers, and broadcasts to dashboards over WebSocket.
// Also serves POST /trade (simulated fills) and demo drivers /mock-event, /mock-odds.
import { baseHalfSpread, quoteMarket, MARKETS, Market, ThreeWay, PAUSE_MS, WIDEN_MS, RiskFactors, Quote } from './quoteModel';
import { Book, emptyBook, applyFill, pnl, settle } from './inventory';
import { getFairValue, getMatchState } from './txline';

const POLL_MS = 8000;
const DEFAULT_FAIR: ThreeWay = { home: 0.4, draw: 0.3, away: 0.3 };

interface State {
  fixtureId: string | null;
  book: Book;
  pausedUntil: number; widenUntil: number; recentEvents: number[];
  lastGoals: number; lastReds: number; lastFair: ThreeWay | null; mockFair: ThreeWay | null;
  log: { t: number; home: number; draw: number; away: number }[];
  lastQuotes: { markets: Record<Market, Quote>; phase: string; ts: number } | null;
  finished: boolean;
}

export interface RoomEnv { TXLINE_API_KEY?: string }

export class QuoteRoom {
  ctx: DurableObjectState; env: RoomEnv;
  constructor(ctx: DurableObjectState, env: RoomEnv) { this.ctx = ctx; this.env = env; }

  async load(): Promise<State> {
    const s = await this.ctx.storage.get<State>('state');
    return s || {
      fixtureId: null, book: emptyBook(), pausedUntil: 0, widenUntil: 0, recentEvents: [],
      lastGoals: 0, lastReds: 0, lastFair: null, mockFair: null, log: [], lastQuotes: null, finished: false,
    };
  }
  save(s: State) { return this.ctx.storage.put('state', s); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const s = await this.load();
    const fx = url.searchParams.get('fixtureId');
    if (fx && s.fixtureId !== fx) { s.fixtureId = fx; await this.save(s); }

    if (url.pathname === '/trade' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})) as { market?: Market; side?: 'buy' | 'sell'; size?: number };
      const res = await this.trade(s, b);
      return json(res);
    }
    if (url.pathname === '/mock-event' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})) as { type?: string };
      await this.fireEvent(s, b.type || 'goal');
      await this.recompute(s); await this.save(s);
      return json({ ok: true });
    }
    if (url.pathname === '/mock-odds' && req.method === 'POST') {
      const b = await req.json().catch(() => ({})) as Partial<ThreeWay>;
      if (b.home && b.draw && b.away) { s.mockFair = { home: b.home, draw: b.draw, away: b.away }; s.lastFair = s.mockFair; }
      await this.recompute(s); await this.save(s);
      return json({ ok: true });
    }
    if (url.pathname === '/quotes' && req.method === 'GET') {
      return json({ quotes: s.lastQuotes, inventory: s.book, pnl: pnl(s.book, s.lastFair || DEFAULT_FAIR), log: s.log });
    }
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.snapshot(s)));
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1500);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const s = await this.load();
    if (s.finished || !s.fixtureId || this.ctx.getWebSockets().length === 0) return;
    try {
      const env = { TXLINE_API_KEY: this.env.TXLINE_API_KEY, jwtCache: {
        get: () => this.ctx.storage.get<string>('jwt').then((v) => v ?? null),
        set: (v: string) => this.ctx.storage.put('jwt', v),
      } };
      const fair = s.mockFair || (await getFairValue(env, s.fixtureId)) || s.lastFair || DEFAULT_FAIR;
      const ms = await getMatchState(env, s.fixtureId);
      if (ms.goals > s.lastGoals || ms.reds > s.lastReds) { await this.fireEvent(s, 'goal'); }
      s.lastGoals = ms.goals; s.lastReds = ms.reds;
      const sharp = !!s.lastFair && MARKETS.some((m) => Math.abs(fair[m] - s.lastFair![m]) > 0.03);
      s.lastFair = fair;
      this.computeAndBroadcast(s, fair, ms.phase, ms, sharp);
      if (ms.finished && ms.winner && ms.winner !== 'draw') settle(s.book, ms.winner);
      else if (ms.finished && ms.winner === 'draw') settle(s.book, 'draw' as Market);
      if (ms.finished) { s.finished = true; this.broadcast({ type: 'finished', pnl: pnl(s.book, fair), inventory: s.book }); }
    } catch (e) { console.log('mm alarm error', String(e)); }
    if (!s.finished) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    await this.save(s);
  }

  // recompute using last known fair (no network) - used after trades / mock events
  async recompute(s: State): Promise<void> {
    const fair = s.mockFair || s.lastFair || DEFAULT_FAIR;
    this.computeAndBroadcast(s, fair, s.lastQuotes?.phase || 'NS', null, false);
  }

  computeAndBroadcast(s: State, fair: ThreeWay, phase: string, ms: any, sharp: boolean): void {
    const now = Date.now();
    const paused = now < s.pausedUntil;
    const risk: RiskFactors = {
      recentEventCount: s.recentEvents.filter((t) => now - t < 300000).length,
      minutesRemaining: approxMinsRemaining(phase),
      sharpMovementActive: sharp,
      matchStatus: phase === 'ET1' || phase === 'ET2' || phase === 'HTET' ? 'extra_time' : (phase === 'PE' ? 'penalties' : 'normal'),
      widen: now < s.widenUntil,
    };
    const half = baseHalfSpread(risk);
    const markets = {} as Record<Market, Quote>;
    for (const m of MARKETS) markets[m] = quoteMarket(fair[m], half, s.book[m].q, paused);
    s.lastQuotes = { markets, phase, ts: now };
    s.log.push({ t: now, home: markets.home.spread, draw: markets.draw.spread, away: markets.away.spread });
    if (s.log.length > 300) s.log = s.log.slice(-300);
    this.broadcast(this.snapshot(s, fair));
  }

  async trade(s: State, b: { market?: Market; side?: 'buy' | 'sell'; size?: number }): Promise<object> {
    if (!b.market || !MARKETS.includes(b.market) || (b.side !== 'buy' && b.side !== 'sell')) return { filled: false, reason: 'bad_request' };
    const size = Number(b.size);
    if (!(size > 0) || size > 100) return { filled: false, reason: 'size_too_large' };
    const q = s.lastQuotes?.markets[b.market];
    if (!q || q.status !== 'live') return { filled: false, reason: 'quotes_pulled' };
    const price = b.side === 'buy' ? q.ask : q.bid;        // user buys at ask / sells at bid
    const dq = b.side === 'buy' ? -size : size;            // user buys → MM goes short the outcome
    applyFill(s.book[b.market], dq, price);
    await this.recompute(s);                               // inventory skew shifts quotes
    await this.save(s);
    return { filled: true, fillPrice: price };
  }

  async fireEvent(s: State, _type: string): Promise<void> {
    const now = Date.now();
    s.pausedUntil = now + PAUSE_MS;
    s.widenUntil = now + WIDEN_MS;
    s.recentEvents.push(now);
    s.recentEvents = s.recentEvents.filter((t) => now - t < 300000);
  }

  snapshot(s: State, fair?: ThreeWay): object {
    const f = fair || s.lastFair || DEFAULT_FAIR;
    return { type: 'quotes', fair: f, quotes: s.lastQuotes, inventory: s.book, pnl: pnl(s.book, f), log: s.log };
  }
  broadcast(msg: unknown): void {
    const str = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(str); } catch { /* closed */ } }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.close(); } catch { /* noop */ } }
}

function approxMinsRemaining(phase: string): number {
  switch (phase) {
    case 'NS': return 90; case 'H1': return 65; case 'HT': return 45;
    case 'H2': return 25; case 'ET1': case 'ET2': case 'HTET': return 10; default: return 5;
  }
}
function json(d: unknown): Response { return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }); }
