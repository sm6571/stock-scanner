/* ── State ── */
let scanResults = [];
let filteredResults = [];
let watchlist = [];
let currentSort = { col: 'score', dir: 'desc' };

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  loadLatestScan();
  loadWatchlist();
  loadMarket();
  loadScanHistory();
  fetch('/auth/status').then(r => r.json()).then(s => {
    if (s.username) document.getElementById('navUser').textContent = s.username;
  });
});

/* ── Theme ── */
function toggleTheme() {
  const next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('scanner-theme', next);
}

/* ── Market Strip ── */
async function loadMarket() {
  try {
    const res = await fetch('/api/market');
    const data = await res.json();
    const strip = document.getElementById('marketStrip');
    let html = '';
    for (const [sym, d] of Object.entries(data)) {
      if (sym === 'VIX') {
        html += `<div class="market-item"><span class="symbol">VIX</span><span class="price">${d.price}</span></div>`;
        continue;
      }
      const cls = d.change_pct >= 0 ? 'text-profit' : 'text-loss';
      const sign = d.change_pct >= 0 ? '+' : '';
      html += `<div class="market-item"><span class="symbol">${sym}</span><span class="price ${cls}">${d.price}</span><span class="${cls}">${sign}${d.change_pct}%</span></div>`;
    }
    // Market status
    const state = data.SPY?.state || 'CLOSED';
    let statusCls = 'closed', statusText = 'Closed';
    if (state === 'REGULAR') { statusCls = 'open'; statusText = 'Market Open'; }
    else if (state === 'PRE') { statusCls = 'pre'; statusText = 'Pre-Market'; }
    else if (state === 'POST') { statusCls = 'pre'; statusText = 'After Hours'; }
    html += `<span style="flex:1"></span><span class="market-status ${statusCls}">${statusText}</span>`;
    strip.innerHTML = html;
  } catch { }
}

/* ── Scan Results ── */
async function loadLatestScan() {
  try {
    const res = await fetch('/api/scan/latest');
    const data = await res.json();
    if (!data.scan) return;
    scanResults = data.results || [];
    document.getElementById('scanInfo').textContent = `Last scan: ${timeAgo(data.scan.scanned_at)} (${data.scan.scan_type})`;
    buildSectorFilter();
    applyFilters();
  } catch { }
}

function buildSectorFilter() {
  const sectors = new Set();
  scanResults.forEach(r => { if (r.sector) sectors.add(r.sector); });
  const sel = document.getElementById('sectorFilter');
  sel.innerHTML = '<option value="">All</option>';
  [...sectors].sort().forEach(s => { sel.innerHTML += `<option value="${esc(s)}">${esc(s)}</option>`; });
}

function applyFilters() {
  const sortBy = document.getElementById('sortBy').value;
  const minScore = parseInt(document.getElementById('minScore').value) || 0;
  const minPrice = parseFloat(document.getElementById('minPrice').value) || 0;
  const sector = document.getElementById('sectorFilter').value;

  filteredResults = scanResults.filter(r =>
    r.score >= minScore && r.price >= minPrice &&
    (!sector || r.sector === sector)
  );

  currentSort.col = sortBy;
  sortAndRender();
}

function sortCol(col) {
  if (currentSort.col === col) currentSort.dir = currentSort.dir === 'desc' ? 'asc' : 'desc';
  else { currentSort.col = col; currentSort.dir = col === 'symbol' || col === 'name' || col === 'sector' ? 'asc' : 'desc'; }
  document.getElementById('sortBy').value = ['score','volume_ratio','atr_pct','gap_pct','change_pct','day_range_pct'].includes(col) ? col : 'score';
  sortAndRender();
}

function sortAndRender() {
  const { col, dir } = currentSort;
  const mult = dir === 'asc' ? 1 : -1;
  filteredResults.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'gap_pct') { va = Math.abs(va); vb = Math.abs(vb); }
    if (typeof va === 'string') return va.localeCompare(vb) * mult;
    return ((va || 0) - (vb || 0)) * mult;
  });
  renderResults();
}

function renderResults() {
  const tbody = document.getElementById('resultsBody');
  const empty = document.getElementById('emptyState');
  document.getElementById('resultCount').textContent = `${filteredResults.length} stocks`;

  if (filteredResults.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const wlSet = new Set(watchlist.map(w => w.symbol));
  let html = '';
  for (const r of filteredResults) {
    const chgCls = r.change_pct >= 0 ? 'text-profit' : 'text-loss';
    const gapCls = r.gap_pct >= 0 ? 'text-profit' : 'text-loss';
    const scoreCls = r.score >= 60 ? 'score-high' : r.score >= 35 ? 'score-mid' : 'score-low';
    const volWidth = Math.min(r.volume_ratio / 5 * 100, 100);
    const inWl = wlSet.has(r.symbol);

    html += `<tr>
      <td><span class="score-badge ${scoreCls}">${r.score}</span></td>
      <td><strong>${r.symbol}</strong></td>
      <td class="hide-mobile text-muted" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.name)}</td>
      <td>$${r.price.toFixed(2)}</td>
      <td class="${chgCls}">${r.change_pct >= 0 ? '+' : ''}${r.change_pct}%</td>
      <td class="${gapCls}">${r.gap_pct >= 0 ? '+' : ''}${r.gap_pct}%</td>
      <td>${r.volume_ratio}x <div class="vol-bar-bg"><div class="vol-bar" style="width:${volWidth}%"></div></div></td>
      <td class="hide-mobile">${fmtVol(r.volume)}</td>
      <td>${r.atr_pct}%</td>
      <td>${r.day_range_pct}%</td>
      <td class="hide-mobile text-muted" style="font-size:.75rem;">${esc(r.sector)}</td>
      <td><span style="cursor:pointer;opacity:${inWl ? 1 : .3}" onclick="quickWatch('${r.symbol}')">${inWl ? '★' : '☆'}</span></td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

/* ── Run Scan ── */
async function runScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Scanning...';
  document.getElementById('scanInfo').textContent = 'Scanning ~250 stocks... this takes 1-2 minutes';
  try {
    await fetch('/api/scan/run', { method: 'POST' });
    await loadLatestScan();
    await loadScanHistory();
  } catch (err) { alert('Scan failed: ' + err.message); }
  btn.disabled = false;
  btn.textContent = '🔍 Scan';
}

/* ── Watchlist ── */
async function loadWatchlist() {
  try {
    const res = await fetch('/api/watchlist');
    watchlist = await res.json();
    renderWatchlist();
  } catch { }
}

function renderWatchlist() {
  const container = document.getElementById('watchlistBody');
  if (watchlist.length === 0) {
    container.innerHTML = '<div class="text-muted small text-center py-2">No stocks saved</div>';
    return;
  }
  let html = '';
  for (const w of watchlist) {
    const cls = (w.change_pct || 0) >= 0 ? 'text-profit' : 'text-loss';
    const sign = (w.change_pct || 0) >= 0 ? '+' : '';
    html += `<div class="watchlist-item">
      <span class="wl-symbol">${w.symbol}</span>
      <span class="${cls}" style="font-size:.8rem;font-weight:600;">${w.price ? '$' + w.price.toFixed(2) : '—'}</span>
      <span class="${cls}" style="font-size:.75rem;">${w.change_pct != null ? sign + w.change_pct + '%' : ''}</span>
      <span style="flex:1"></span>
      <span class="wl-remove" onclick="removeWatch('${w.symbol}')">✕</span>
    </div>`;
  }
  container.innerHTML = html;
}

function openAddWatchlist() {
  document.getElementById('wlSymbol').value = '';
  document.getElementById('wlNotes').value = '';
  new bootstrap.Modal(document.getElementById('watchlistModal')).show();
}

async function addToWatchlist() {
  const symbol = document.getElementById('wlSymbol').value.trim().toUpperCase();
  const notes = document.getElementById('wlNotes').value.trim();
  if (!symbol) return;
  await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, notes }) });
  bootstrap.Modal.getInstance(document.getElementById('watchlistModal')).hide();
  await loadWatchlist();
  renderResults(); // update star states
}

async function quickWatch(symbol) {
  const inWl = watchlist.find(w => w.symbol === symbol);
  if (inWl) {
    await fetch(`/api/watchlist/${symbol}`, { method: 'DELETE' });
  } else {
    await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol }) });
  }
  await loadWatchlist();
  renderResults();
}

async function removeWatch(symbol) {
  await fetch(`/api/watchlist/${symbol}`, { method: 'DELETE' });
  await loadWatchlist();
  renderResults();
}

/* ── Scan History ── */
async function loadScanHistory() {
  try {
    const res = await fetch('/api/scan/history');
    const scans = await res.json();
    const container = document.getElementById('scanHistory');
    if (scans.length === 0) { container.innerHTML = '<div class="text-muted small text-center py-2">No scans yet</div>'; return; }
    let html = '';
    for (const s of scans) {
      html += `<div class="d-flex justify-content-between py-1" style="font-size:.78rem;border-bottom:1px solid var(--border-color);cursor:pointer;" onclick="loadScan(${s.id})">
        <span>${timeAgo(s.scanned_at)} <span class="text-muted">(${s.scan_type})</span></span>
        <span class="text-muted">${s.result_count} results</span>
      </div>`;
    }
    container.innerHTML = html;
  } catch { }
}

async function loadScan(id) {
  try {
    const res = await fetch(`/api/scan/${id}`);
    const data = await res.json();
    scanResults = data.results || [];
    document.getElementById('scanInfo').textContent = `Scan: ${timeAgo(data.scan.scanned_at)} (${data.scan.scan_type})`;
    buildSectorFilter();
    applyFilters();
  } catch { }
}

/* ── Helpers ── */
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toString();
}

function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login';
}
