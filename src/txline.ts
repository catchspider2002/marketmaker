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
  // Prefer the FULL-TIME 1X2 market: in-play snapshots also carry same-shaped period markets
  // (first-half result etc.), and picking one of those reads as nonsense (a "95% draw" logged in
  // first-half stoppage was really the H1-result market, not the match odds).
  const rank = (o: any) => (/1X2/i.test(o.SuperOddsType || '') ? 4 : 0) + (o.MarketPeriod ? 0 : 2) + (/stable/i.test(o.Bookmaker || '') || /stable/i.test(o.SuperOddsType || '') ? 1 : 0);
  const pick = cands.slice().sort((a, b) => rank(b) - rank(a))[0];
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
  const phase = phaseFromActions(arr);
  const rec = latestStatRec(arr);
  const sm = statMap(rec);
  const sc = rec?.ScoreSoccer ?? rec?.scoreSoccer;
  const g1 = sm.get(1) ?? num(sc?.Participant1?.Total?.Goals);
  const g2 = sm.get(2) ?? num(sc?.Participant2?.Total?.Goals);
  const reds = (sm.get(5) ?? num(sc?.Participant1?.Total?.RedCards)) + (sm.get(6) ?? num(sc?.Participant2?.Total?.RedCards));
  const p1IsHome = (rec?.Participant1IsHome ?? rec?.participant1IsHome) !== false;
  const finished = FINISHED.has(phase);
  let winner: MatchState['winner'] = null;
  if (finished) {
    if (g1 > g2) winner = p1IsHome ? 'home' : 'away';
    else if (g2 > g1) winner = p1IsHome ? 'away' : 'home';
    else winner = 'draw';
  }
  return { phase, started: phase !== 'NS', finished, goals: g1 + g2, reds, g1, g2, p1IsHome, winner };
}

// TxLINE soccer game-phase encoding (numeric id → code). Docs: scores/soccer-feed.
function phaseFromActions(arr: any[]): string {
  let hasKick = false, htSeq = -1, finalised = false;
  for (const r of arr) {
    const a = String(r?.Action || '');
    const s = seqOf(r);
    if (a === 'kickoff' || a === 'kickoff_team') hasKick = true;
    if (a === 'halftime_finalised' && s > htSeq) htSeq = s;
    if (a === 'game_finalised') finalised = true;
  }
  if (finalised) return 'F';
  if (htSeq >= 0) {
    for (const r of arr) if (String(r?.Action || '') === 'kickoff' && seqOf(r) > htSeq) return 'H2';
    return 'HT';
  }
  return hasKick ? 'H1' : 'NS';
}
function seqOf(u: any): number { return num(u?.Seq ?? u?.seq ?? u?.Timestamp ?? u?.timestamp ?? u?.Ts ?? u?.ts); }
function hasStats(u: any): boolean { const s = u?.Stats ?? u?.stats; return !!s && typeof s === 'object' && (s['1'] != null || s['2'] != null); }
function latestStatRec(arr: any[]): any {
  let best: any = null;
  for (const r of arr) if (hasStats(r) && (!best || seqOf(r) > seqOf(best))) best = r;
  return best ?? (arr.length ? arr.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a)) : {});
}
function statMap(u: any): Map<number, number> {
  const m = new Map<number, number>();
  const s = u?.Stats ?? u?.stats;
  if (Array.isArray(s)) { for (const it of s) { const k = Number(it?.Key ?? it?.key ?? it?.[0]); if (Number.isFinite(k)) m.set(k, num(it?.Value ?? it?.value ?? it?.[1])); } }
  else if (s && typeof s === 'object') { for (const k of Object.keys(s)) { const kn = Number(k); if (Number.isFinite(kn)) m.set(kn, num((s as any)[k])); } }
  return m;
}
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
