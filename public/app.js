// MarketMaker dashboard.
const qs = (s) => document.querySelector(s);
const api = (p, o) => fetch(p, o).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
const MK = ['home', 'draw', 'away'];

let ws = null, fixtureId = null, chart = null, adminKey = null;

init();
async function init() {
  try {
    const { fixtures, note } = await api('/api/matches');
    const sel = qs('#fixture');
    if (note) { sel.innerHTML = `<option value="">${note}</option>`; return; }
    // Only live or upcoming matches — drop ones that kicked off > ~2h45m ago (finished).
    const now = Date.now(); const norm = (t) => (t < 1e12 ? t * 1000 : t);
    const live = fixtures.filter((f) => norm(f.startTime) >= now - 2.75 * 3600e3).sort((a, b) => norm(a.startTime) - norm(b.startTime));
    sel.innerHTML = '<option value="">Pick a match…</option>' +
      live.map((f) => `<option value="${f.fixtureId}">${f.home} vs ${f.away}</option>`).join('');
    sel.addEventListener('change', () => openRoom(sel.value));
  } catch (e) { qs('#fixture').innerHTML = `<option>Couldn't load: ${e.message}</option>`; }

  qs('#t-exec').addEventListener('click', trade);
  setupDemo();
}

// Demo controls (mock goal / mock odds) are admin-only: the panel is hidden for normal visitors
// and revealed with ?admin=KEY (stored locally). The key rides on X-Admin-Key via post();
// the gated /api/mock-event and /api/mock-odds reject anything else.
function setupDemo() {
  const u = new URL(location.href);
  let key = u.searchParams.get('admin');
  if (key) { try { localStorage.setItem('admin_key', key); } catch {} history.replaceState(null, '', u.pathname); }
  if (!key) { try { key = localStorage.getItem('admin_key'); } catch {} }
  const panel = qs('#demo-controls');
  if (!key) { if (panel) panel.style.display = 'none'; return; }
  adminKey = key;
  if (panel) panel.style.display = '';
  qs('#m-goal').addEventListener('click', () => fixtureId && api(`/api/mock-event/${fixtureId}`, post({ type: 'goal' })));
  qs('#m-odds').addEventListener('click', setOdds);
}

function openRoom(id) {
  fixtureId = id;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (!id) return;
  initChart();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/api/events/${id}`);
    ws.onopen = () => { qs('#conn').textContent = '● live'; qs('#conn').style.color = '#16A34A'; };
    ws.onclose = () => { qs('#conn').textContent = '○ reconnecting…'; qs('#conn').style.color = ''; if (fixtureId === id) setTimeout(connect, 3000); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } render(m); };
  };
  connect();
}

function render(m) {
  if (m.type === 'finished') qs('#phase').textContent = 'FULL TIME';
  const q = m.quotes; const f = m.fair || {};
  if (q && q.markets) {
    qs('#phase').textContent = q.phase || '-';
    for (const mk of MK) {
      const c = q.markets[mk];
      qs(`#f-${mk}`).textContent = pct(c.fairValue);
      qs(`#b-${mk}`).textContent = pct(c.bid);
      qs(`#a-${mk}`).textContent = pct(c.ask);
      qs(`#s-${mk}`).textContent = (c.spread * 100).toFixed(1) + 'pp';
      const st = qs(`#st-${mk}`); st.textContent = c.status.toUpperCase(); st.className = c.status === 'live' ? 'st-live' : 'st-paused';
    }
  }
  if (m.inventory) {
    qs('#inv-body').innerHTML = MK.map((mk) => {
      const p = m.inventory[mk];
      const cls = p.q > 0 ? 'pos-pos' : p.q < 0 ? 'pos-neg' : '';
      return `<tr><td>${mk}</td><td class="${cls}">${p.q.toFixed(1)}</td><td>${p.q ? pct(p.avgP) : '-'}</td><td>${p.realised.toFixed(3)}</td></tr>`;
    }).join('');
  }
  if (m.pnl) {
    const t = m.pnl.total;
    qs('#pnl').innerHTML = `Realised ${m.pnl.realised.toFixed(3)} · Unrealised ${m.pnl.unrealised.toFixed(3)} · ` +
      `<b class="${t >= 0 ? 'pos-pos' : 'pos-neg'}">Total ${t.toFixed(3)} USDC</b>`;
  }
  if (m.log && chart) {
    chart.data.labels = m.log.map((_, i) => i);
    chart.data.datasets[0].data = m.log.map((d) => d.home * 100);
    chart.data.datasets[1].data = m.log.map((d) => d.draw * 100);
    chart.data.datasets[2].data = m.log.map((d) => d.away * 100);
    chart.update('none');
  }
}

async function trade() {
  if (!fixtureId) return;
  const body = { market: qs('#t-market').value, side: qs('#t-side').value, size: Number(qs('#t-size').value) };
  try {
    const r = await api(`/api/trade/${fixtureId}`, post(body));
    qs('#t-out').textContent = r.filled ? `Filled ${body.side} ${body.size} ${body.market} @ ${pct(r.fillPrice)}` : `Rejected: ${r.reason}`;
  } catch (e) { qs('#t-out').textContent = e.message; }
}

function setOdds() {
  if (!fixtureId) return;
  const d = { home: Number(qs('#o-home').value), draw: Number(qs('#o-draw').value), away: Number(qs('#o-away').value) };
  const raw = { home: 1 / d.home, draw: 1 / d.draw, away: 1 / d.away };
  const s = raw.home + raw.draw + raw.away;
  api(`/api/mock-odds/${fixtureId}`, post({ home: raw.home / s, draw: raw.draw / s, away: raw.away / s }));
}

function initChart() {
  const ctx = qs('#chart').getContext('2d');
  if (chart) chart.destroy();
  const ds = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: color, tension: 0.3, pointRadius: 0, borderWidth: 2 });
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [ds('Home', '#16A34A'), ds('Draw', '#8888A4'), ds('Away', '#DC2626')] },
    options: { animation: false, scales: { y: { title: { display: true, text: 'spread (pp)' }, ticks: { color: '#8888A4' }, grid: { color: 'rgba(0,0,0,0.06)' } }, x: { display: false } }, plugins: { legend: { labels: { color: '#1A1A2E', font: { family: 'Inter' } } } } },
  });
}

function post(body) { const h = { 'Content-Type': 'application/json' }; if (adminKey) h['X-Admin-Key'] = adminKey; return { method: 'POST', headers: h, body: JSON.stringify(body) }; }
