// MarketMaker hackathon demo (~2.5 min):
//   Act 1 - the problem (slides: quoting two-way prices in-play without getting run over)
//   Act 2 - live app walkthrough (pick a match → live quotes over WebSocket → trade round-trip → P&L)
//   Act 3 - how TxLINE powers the backend (architecture slide + REAL live TxLINE JSON)
// Fully automated; captions/slides carry the narrative so no voiceover is needed.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BASE = 'https://marketmaker.wc26hackathon.com';
const OUT = './video';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pull REAL TxLINE data to show in Act 3 ----
const KEY = readFileSync('/Users/naveencs/Downloads/app store projects/solana-world-cup/bracketboss/.dev.vars', 'utf8')
  .match(/^TXLINE_API_KEY=(.*)$/m)[1].trim().replace(/^"|"$/g, '');
const jwt = (await (await fetch('https://txline.txodds.com/auth/guest/start', { method: 'POST' })).json()).token;
const tx = (p) => fetch('https://txline.txodds.com' + p, { headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': KEY } }).then((r) => r.json());

const upcoming = (await tx('/api/fixtures/snapshot?competitionId=72'))
  .filter((f) => f.StartTime > Date.now()).sort((a, b) => a.StartTime - b.StartTime).slice(0, 8);
const rank = (o) => (/1X2/i.test(o.SuperOddsType || '') ? 4 : 0) + (o.MarketPeriod ? 0 : 2);
let next, pick;
for (const f of upcoming) {
  const oddsArr = await tx(`/api/odds/snapshot/${f.FixtureId}`);
  const cand = (Array.isArray(oddsArr) ? oddsArr : [])
    .filter((o) => Array.isArray(o.PriceNames) && o.PriceNames.length === 3 && Array.isArray(o.Pct))
    .sort((a, b) => rank(b) - rank(a))[0];
  if (cand) { next = f; pick = cand; break; }
}
if (!pick) throw new Error('no upcoming fixture with a priced 1X2 market');
const oddsSample = {
  FixtureId: next.FixtureId,
  Fixture: `${next.Participant1} vs ${next.Participant2}`,
  StartTime: new Date(next.StartTime).toISOString(),
  SuperOddsType: pick.SuperOddsType, Bookmaker: pick.Bookmaker,
  PriceNames: pick.PriceNames, Prices: pick.Prices, Pct: pick.Pct,
};

// ---- fixture to demo in the app: next upcoming from the app's own list ----
const { fixtures } = await (await fetch(`${BASE}/api/matches`)).json();
const fx = fixtures.slice().sort((a, b) => a.startTime - b.startTime)[0];
if (!fx) throw new Error('no fixtures listed in the app');

// ---- slide deck ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const jsonHtml = (o) => `<pre class="code">${esc(JSON.stringify(o, null, 2))}</pre>`;
const slides = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0b1120;color:#f1f5f9}
  .slide{display:none;width:100vw;height:100vh;box-sizing:border-box;padding:64px 90px;flex-direction:column;justify-content:center}
  .slide.on{display:flex}
  .brand{color:#22d3ee;font-weight:800}
  h1{font-size:54px;margin:0 0 18px} h2{font-size:40px;margin:0 0 26px}
  p,li{font-size:26px;line-height:1.55;color:#cbd5e1} li{margin-bottom:14px}
  .tag{font-size:20px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px}
  .code{background:#020617;border:1px solid #1e293b;border-radius:12px;padding:20px 26px;font:16px/1.55 ui-monospace,Menlo,monospace;color:#7dd3fc;overflow:hidden;max-height:52vh}
  .flow{display:flex;align-items:center;gap:14px;margin-top:30px;flex-wrap:wrap}
  .box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 20px;font-size:20px;font-weight:600}
  .box small{display:block;font-weight:400;color:#94a3b8;font-size:15px;margin-top:4px}
  .arrow{color:#22d3ee;font-size:26px;font-weight:700}
  .accent{color:#22d3ee}
</style></head><body>

<div class="slide" id="s1" style="text-align:center;align-items:center">
  <h1 style="font-size:72px">💹 <span class="brand">MarketMaker</span></h1>
  <p style="font-size:30px">An autonomous in-play market maker for World Cup 2026 outcomes<br>Trading Tools &amp; Agents · powered by the <b class="accent">TxLINE</b> live odds feed</p>
</div>

<div class="slide" id="s2">
  <div class="tag">The problem</div>
  <h2>Quoting two-way prices in-play is the hardest job in trading</h2>
  <ul>
    <li>A market maker must show a <b>bid and an ask at all times</b> - and someone always knows something before you do</li>
    <li>A goal lands: quote on stale prices for even a few seconds and informed traders <b>run you over</b></li>
    <li>Every fill creates <b>inventory risk</b> - lean the wrong way into full time and one result wipes the spread you earned</li>
  </ul>
</div>

<div class="slide" id="s3">
  <div class="tag">The fix</div>
  <h2><span class="brand">MarketMaker</span>: a bot that quotes like a production desk</h2>
  <ul>
    <li>Fair value = <b class="accent">TxLINE demargined odds</b> (overround removed) - a clean mid-price, refreshed every ~8 seconds</li>
    <li>A named spread model widens on events, late game, extra time and <b>inventory skew</b>; on a goal it <b>pulls quotes for 30s</b>, then returns at 2× spread</li>
    <li>A simulated order book fills trades at the live quote and marks P&amp;L to fair value - all deterministic math, fully commented</li>
  </ul>
  <p style="margin-top:26px">Let's trade against it. →</p>
</div>

<div class="slide" id="s4">
  <div class="tag">Under the hood</div>
  <h2>How <span class="accent">TxLINE</span> powers the backend</h2>
  <div class="flow">
    <div class="box">TxLINE API<small>demargined odds + scores</small></div>
    <div class="arrow">→</div>
    <div class="box">QuoteRoom DO (per fixture)<small>~8s alarm → fair value + events</small></div>
    <div class="arrow">→</div>
    <div class="box">Quote engine<small>spread model + risk timers + inventory</small></div>
    <div class="arrow">→</div>
    <div class="box">WebSocket + trade API<small>dashboards + simulated fills</small></div>
  </div>
  <ul style="margin-top:34px">
    <li><b>fair value</b> - <span class="accent">TXLineStablePriceDemargined</span> Pct is the mid: the overround is already stripped by the feed</li>
    <li><b>risk</b> - goals/reds arrive via the scores snapshot: pause 30s, re-quote at 2× spread for 120s</li>
    <li><b>settle</b> - on <span class="accent">game_finalised</span>, positions settle against the real result</li>
  </ul>
</div>

<div class="slide" id="s5">
  <div class="tag">Live TxLINE data · odds snapshot (full-time 1X2)</div>
  <h2>${esc(next.Participant1)} vs ${esc(next.Participant2)} - the fair value source, straight from the feed</h2>
  ${jsonHtml(oddsSample)}
  <p style="margin-top:22px">The <b>Pct</b> array is the demargined probability - the QuoteRoom wraps its bid/ask around exactly these numbers.</p>
</div>

<div class="slide" id="s6" style="text-align:center;align-items:center">
  <h1><span class="brand">MarketMaker</span></h1>
  <p style="font-size:28px">marketmaker.wc26hackathon.com<br><br>Always a price. Never run over. <span class="accent">Spread is the edge.</span> 💹</p>
</div>

<script>window.show=(id)=>{document.querySelectorAll('.slide').forEach(s=>s.classList.remove('on'));document.getElementById(id).classList.add('on')}</script>
</body></html>`;
const slidesPath = resolve('./slides.html');
writeFileSync(slidesPath, slides);

// ---- recording ----
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

let currentCaption = '';
async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-cap');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'background:rgba(10,14,26,.92);color:#fff;padding:12px 22px;border-radius:12px;' +
        'font:600 19px/1.3 -apple-system,system-ui,sans-serif;z-index:99999;max-width:900px;' +
        'text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.15)';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
async function cap(text, holdMs = 2600) { currentCaption = text; await caption(text); await sleep(holdMs); }
page.on('load', () => { if (currentCaption) caption(currentCaption).catch(() => { }); });
async function clearCap() {
  currentCaption = '';
  await page.evaluate(() => document.getElementById('demo-cap')?.remove()).catch(() => { });
}
async function slide(id, holdMs) {
  if (!page.url().startsWith('file:')) await page.goto('file://' + slidesPath);
  await page.evaluate((i) => window.show(i), id);
  await sleep(holdMs);
}

// ============ ACT 1 - the problem (slides) ============
await page.goto('file://' + slidesPath);
await slide('s1', 6000);
await slide('s2', 12000);
await slide('s3', 12000);

// ============ ACT 2 - live walkthrough ============
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector(`#fixture option[value="${fx.fixtureId}"]`, { state: 'attached' });
await cap('The live dashboard - only live and upcoming World Cup matches are quotable', 3600);
await page.selectOption('#fixture', String(fx.fixtureId));
// WebSocket connects; the Durable Object's alarm pulls real TxLINE odds within a few seconds.
// Reject the DO's 40/30/30 placeholder - wait for the actual demargined feed to land.
await page.waitForFunction(() => {
  const h = document.getElementById('f-home')?.textContent || '-';
  const d = document.getElementById('f-draw')?.textContent || '-';
  return h !== '-' && !(h.startsWith('40.0') && d.startsWith('30.0'));
}, null, { timeout: 120000 });
await sleep(6000); // let a couple more polls land
await cap(`${fx.home} vs ${fx.away}: fair value is TxLINE's demargined price, streamed over WebSocket every ~8s`, 5000);
await cap('Around it, a live two-way market: bid below, ask above, spread from the risk model', 4600);

// Trade round-trip: buy then sell -> flat book, MM keeps the spread.
await page.evaluate(() => document.querySelector('.quotes')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
await sleep(600);
await cap(`Let's trade against it: buy 20 ${fx.home} at the ask…`, 3000);
await page.selectOption('#t-market', 'home');
await page.selectOption('#t-side', 'buy');
await page.fill('#t-size', '20');
await page.click('#t-exec');
await sleep(1500);
await page.evaluate(() => document.querySelector('.inv')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
await sleep(1000);
await cap('Filled at the ask. The bot is now short that outcome - watch the inventory row and the skewed quote', 4800);

await cap('Now sell the same 20 back - the bot buys at its bid…', 3000);
await page.selectOption('#t-side', 'sell');
await page.click('#t-exec');
await sleep(1500);
await page.evaluate(() => document.getElementById('pnl')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
await sleep(1000);
await cap('Book flat again - and the realised P&L is positive. That gap was the spread: the market maker\'s edge', 5200);

// Spread history chart.
await page.evaluate(() => document.getElementById('chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
await sleep(1200);
await cap('Spread history per market - in a live match you\'d see it spike to 2× after every goal, then settle', 4600);
await cap('During matches this runs hands-off: TxLINE odds move the mid, goals trigger the pause-and-widen cycle', 4600);
await clearCap();

// ============ ACT 3 - TxLINE backend ============
await page.goto('file://' + slidesPath);
await slide('s4', 14000);
await slide('s5', 11000);
await slide('s6', 5000);

await ctx.close();
await browser.close();
console.log('DONE - raw webm in ' + OUT);
