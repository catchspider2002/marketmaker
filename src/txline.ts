// MarketMaker - TxLINE client: auth + fixtures + fair value (odds) + match state (scores).
import { fairFromPct, ThreeWay } from './quoteModel';

const BASE = 'https://txline.txodds.com';

export interface TxEnv { TXLINE_API_KEY?: string; jwtCache?: { get(): Promise<string | null>; set(v: string): Promise<void> } }

async function getJwt(env: TxEnv, force = false): Promise<string> {
  if (!force && env.jwtCache) { const c = await env.jwtCache.get(); if (c) return c; }
  const r = await fetch(`${BASE}/auth/guest/start`, { method: 'POST' });
  if (!r.ok) throw new Error('guest start failed: ' + r.status);
  const token = (await r.json() as { token: string }).token;
  if (env.jwtCache) await env.jwtCache.set(token);
  return token;
}
async function authedGet(env: TxEnv, path: string): Promise<Response> {
  if (!env.TXLINE_API_KEY) throw new Error('TXLINE_API_KEY not set');
  let jwt = await getJwt(env);
  const h = () => ({ Authorization: `Bearer ${jwt}`, 'X-Api-Token': env.TXLINE_API_KEY! });
  let res = await fetch(BASE + path, { headers: h() });
  if (res.status === 401) { jwt = await getJwt(env, true); res = await fetch(BASE + path, { headers: h() }); }
  return res;
}

export interface TxFixture { fixtureId: number; competition: string; startTime: number; home: string; away: string; }

// Keep ONLY the senior men's FIFA World Cup 2026 - excludes qualifiers, youth (U-17/U-20),
// women's, Club World Cup, beach/futsal/esports, and any other edition/year.
function isMainWorldCup(name: string): boolean {
  const s = (name || '').toLowerCase();
  if (!/world cup/.test(s)) return false;
  if (/qualif|wom(e|a)n|u-?\d{1,2}|under[\s-]?\d{1,2}|youth|club|beach|futsal|esoccer|e-?sports|e[\s-]?world/.test(s)) return false;
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (year && year[0] !== '2026') return false;
  return true;
}

export async function listFixtures(env: TxEnv, competitionId?: number): Promise<TxFixture[]> {
  const q = competitionId ? `?competitionId=${competitionId}` : '';
  const res = await authedGet(env, '/api/fixtures/snapshot' + q);
  if (!res.ok) throw new Error('fixtures ' + res.status);
  const arr = await res.json() as any[];
  return arr.map((f) => {
    const p1Home = !!f.Participant1IsHome;
    return { fixtureId: f.FixtureId, competition: f.Competition, startTime: f.StartTime,
      home: p1Home ? f.Participant1 : f.Participant2, away: p1Home ? f.Participant2 : f.Participant1 };
  }).filter((f) => (competitionId ? true : isMainWorldCup(f.competition || '')));
}

/** Fair value (demargined probabilities) for the 3-way match-result market. */
export async function getFairValue(env: TxEnv, fixtureId: string | number): Promise<ThreeWay | null> {
  const res = await authedGet(env, `/api/odds/snapshot/${fixtureId}`);
  if (!res.ok) return null;
  const arr = await res.json() as any[];
  if (!Array.isArray(arr)) return null;
  const cands = arr.filter((o) => Array.isArray(o.PriceNames) && o.PriceNames.length === 3 && Array.isArray(o.Pct));
  const pick = cands.find((o) => /stable/i.test(o.Bookmaker || '') || /stable/i.test(o.SuperOddsType || '')) || cands[0];
  if (!pick) return null;
  const pct = (pick.Pct as string[]).map((x) => (x === 'NA' ? NaN : Number(x)));
  if (pct.some((x) => !Number.isFinite(x))) return null;
  const names = (pick.PriceNames as string[]).map((s) => String(s).toLowerCase());
  const di = idxOf(names, ['x', 'draw'], 1);
  const hi = idxOf(names, ['1', 'home'], 0);
  const ai = idxOf(names, ['2', 'away'], 2);
  return fairFromPct({ home: pct[hi], draw: pct[di], away: pct[ai] });
}
function idxOf(names: string[], keys: string[], fallback: number): number {
  const i = names.findIndex((n) => keys.some((k) => n === k || n.includes(k)));
  return i >= 0 ? i : fallback;
}

export interface MatchState {
  phase: string; started: boolean; finished: boolean;
  goals: number; reds: number; g1: number; g2: number; p1IsHome: boolean;
  winner: 'home' | 'draw' | 'away' | null;
}
const FINISHED = new Set(['F', 'FET', 'FPE']);
export async function getMatchState(env: TxEnv, fixtureId: string | number): Promise<MatchState> {
  const empty: MatchState = { phase: 'NS', started: false, finished: false, goals: 0, reds: 0, g1: 0, g2: 0, p1IsHome: true, winner: null };
  const res = await authedGet(env, `/api/scores/snapshot/${fixtureId}`);
  if (!res.ok) return empty;
  const arr = await res.json() as any[];
  if (!Array.isArray(arr) || arr.length === 0) return empty;
  const latest = arr.reduce((a, b) => ((b?.seq ?? b?.ts ?? 0) > (a?.seq ?? a?.ts ?? 0) ? b : a));
  const phase = phaseOf(latest);
  const st = latest?.stats || {};
  const sc = latest?.scoreSoccer;
  const n = (k: string, fb?: number) => (st[k] != null ? num(st[k]) : (fb ?? 0));
  const g1 = n('1', num(sc?.Participant1?.Total?.Goals));
  const g2 = n('2', num(sc?.Participant2?.Total?.Goals));
  const reds = n('5', num(sc?.Participant1?.Total?.RedCards)) + n('6', num(sc?.Participant2?.Total?.RedCards));
  const p1IsHome = latest?.participant1IsHome !== false;
  const finished = FINISHED.has(phase);
  let winner: MatchState['winner'] = null;
  if (finished) {
    if (g1 > g2) winner = p1IsHome ? 'home' : 'away';
    else if (g2 > g1) winner = p1IsHome ? 'away' : 'home';
    else winner = 'draw';
  }
  return { phase, started: phase !== 'NS', finished, goals: g1 + g2, reds, g1, g2, p1IsHome, winner };
}

function phaseOf(u: any): string {
  if (typeof u?.gameState === 'string' && u.gameState) return u.gameState;
  const s = u?.statusSoccerId;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') return Object.keys(s)[0] || 'NS';
  return 'NS';
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
