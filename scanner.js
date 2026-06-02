const { getDb } = require('./database');
const TICKERS = require('./tickers');
const cron = require('node-cron');

const BATCH_SIZE = 10;
const BATCH_DELAY = 1500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchQuotes(symbols) {
  const results = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (symbol) => {
      try {
        // Use 1mo range to get avg volume from historical bars
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo&includePrePost=false`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) { if (i === 0) console.error(`  [${symbol}] HTTP ${res.status}`); return; }
        const data = await res.json();
        const r = data.chart?.result?.[0];
        if (!r) { if (i === 0) console.error(`  [${symbol}] no chart result`); return; }
        const meta = r.meta || {};
        const q = r.indicators?.quote?.[0] || {};
        const len = q.volume?.length || 0;
        if (len === 0 || !meta.regularMarketPrice) { if (i === 0) console.error(`  [${symbol}] no data, len=${len}, price=${meta.regularMarketPrice}`); return; }

        // Latest day data
        const vol = q.volume[len - 1] || 0;
        const high = q.high?.[len - 1] || meta.regularMarketPrice;
        const low = q.low?.[len - 1] || meta.regularMarketPrice;
        const open = q.open?.[len - 1] || meta.regularMarketPrice;

        // Compute avg volume from prior days (exclude today)
        let totalVol = 0, volDays = 0;
        for (let j = 0; j < len - 1; j++) {
          if (q.volume[j] > 0) { totalVol += q.volume[j]; volDays++; }
        }
        const avgVolume = volDays > 0 ? Math.round(totalVol / volDays) : vol;

        // Compute ATR from historical bars (skip today)
        const bars = [];
        for (let j = 0; j < len; j++) {
          if (q.high?.[j] != null && q.low?.[j] != null && q.close?.[j] != null) {
            bars.push({ high: q.high[j], low: q.low[j], close: q.close[j] });
          }
        }
        const atr = calculateATR(bars.slice(-15));
        const atrPct = meta.regularMarketPrice > 0 ? Math.round((atr / meta.regularMarketPrice) * 10000) / 100 : 0;

        results.push({
          symbol: meta.symbol || symbol,
          shortName: meta.shortName || meta.longName || symbol,
          regularMarketPrice: meta.regularMarketPrice,
          regularMarketVolume: meta.regularMarketVolume || vol,
          regularMarketOpen: open,
          regularMarketDayHigh: meta.regularMarketDayHigh || high,
          regularMarketDayLow: meta.regularMarketDayLow || low,
          regularMarketPreviousClose: meta.chartPreviousClose || 0,
          regularMarketChangePercent: meta.chartPreviousClose
            ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
          averageDailyVolume3Month: avgVolume,
          marketCap: 0,
          sector: '',
          marketState: meta.marketState || 'CLOSED',
          atr: Math.round(atr * 100) / 100,
          atrPct
        });
      } catch (err) { if (i === 0) console.error(`  [${symbol}] error:`, err.message); }
    }));
    if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
  }
  return results;
}

async function fetchHistorical(symbol, days = 20) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.high?.[i] != null && q.low?.[i] != null && q.close?.[i] != null) {
        bars.push({ high: q.high[i], low: q.low[i], close: q.close[i], open: q.open?.[i] || 0 });
      }
    }
    return bars.slice(-days);
  } catch {
    return [];
  }
}

function calculateATR(bars) {
  if (bars.length < 2) return 0;
  let totalTR = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    totalTR += tr;
  }
  return totalTR / (bars.length - 1);
}

function scoreStock(data) {
  const volRatioScore = Math.min(data.volume_ratio * 20, 100);
  const atrPctScore = Math.min(data.atr_pct * 20, 100);
  const gapScore = Math.min(Math.abs(data.gap_pct) * 10, 100);
  const rangeScore = Math.min(data.day_range_pct * 10, 100);
  return Math.round(
    (volRatioScore * 0.3) + (atrPctScore * 0.3) + (gapScore * 0.2) + (rangeScore * 0.2)
  );
}

async function runScan(scanType = 'manual') {
  console.log(`[${new Date().toISOString()}] Starting ${scanType} scan...`);
  const db = getDb();

  const quotes = await fetchQuotes(TICKERS);
  console.log(`  Fetched ${quotes.length} quotes`);

  const filtered = quotes.filter(q =>
    q.regularMarketPrice > 5 &&
    (q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0) > 500000
  );

  const results = [];
  for (const q of filtered) {
    const price = q.regularMarketPrice || 0;
    const prevClose = q.regularMarketPreviousClose || price;
    const open = q.regularMarketOpen || price;
    const high = q.regularMarketDayHigh || price;
    const low = q.regularMarketDayLow || price;
    const volume = q.regularMarketVolume || 0;
    const avgVolume = q.averageDailyVolume3Month || q.averageDailyVolume10Day || 1;
    const changePct = q.regularMarketChangePercent || 0;

    const volumeRatio = Math.round((volume / avgVolume) * 100) / 100;
    if (volumeRatio < 1.0) continue;

    const gapPct = prevClose > 0 ? Math.round(((open - prevClose) / prevClose) * 10000) / 100 : 0;
    const dayRangePct = open > 0 ? Math.round(((high - low) / open) * 10000) / 100 : 0;

    results.push({
      symbol: q.symbol, name: q.shortName || q.symbol,
      price: Math.round(price * 100) / 100, change_pct: Math.round(changePct * 100) / 100,
      volume, avg_volume: avgVolume, volume_ratio: volumeRatio,
      atr: q.atr || 0, atr_pct: q.atrPct || 0, day_range_pct: dayRangePct, gap_pct: gapPct,
      market_cap: q.marketCap || 0, sector: q.sector || '',
      day_high: high, day_low: low, prev_close: prevClose, open_price: open, score: 0
    });
  }

  // ATR already computed in fetchQuotes — just score and rank
  const topCandidates = results.sort((a, b) => b.volume_ratio - a.volume_ratio).slice(0, 80);

  topCandidates.forEach(s => { s.score = scoreStock(s); });
  topCandidates.sort((a, b) => b.score - a.score);

  const scan = db.prepare('INSERT INTO scans (scan_type, stock_count, result_count) VALUES (?, ?, ?)')
    .run(scanType, quotes.length, topCandidates.length);

  const insert = db.prepare(`
    INSERT INTO scan_results (scan_id, symbol, name, price, change_pct, volume, avg_volume,
      volume_ratio, atr, atr_pct, day_range_pct, gap_pct, market_cap, sector, score,
      day_high, day_low, prev_close, open_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const saveAll = db.transaction(() => {
    for (const s of topCandidates) {
      insert.run(scan.lastInsertRowid, s.symbol, s.name, s.price, s.change_pct,
        s.volume, s.avg_volume, s.volume_ratio, s.atr, s.atr_pct, s.day_range_pct,
        s.gap_pct, s.market_cap, s.sector, s.score, s.day_high, s.day_low,
        s.prev_close, s.open_price);
    }
  });
  saveAll();

  console.log(`  Scan complete: ${topCandidates.length} results, top score: ${topCandidates[0]?.score || 0}`);
  return { scanId: scan.lastInsertRowid, count: topCandidates.length };
}

function startScheduler() {
  // Pre-market picks: 6:25 AM PST / 9:25 AM ET (right before open)
  cron.schedule('25 9 * * 1-5', () => runScan('quickpick'), { timezone: 'America/New_York' });
  // Market open: 9:35 AM ET
  cron.schedule('35 9 * * 1-5', () => runScan('open'), { timezone: 'America/New_York' });
  // Midday: 12:00 PM ET
  cron.schedule('0 12 * * 1-5', () => runScan('midday'), { timezone: 'America/New_York' });
  // Early pre-market: 8:00 AM ET
  cron.schedule('0 8 * * 1-5', () => runScan('premarket'), { timezone: 'America/New_York' });

  console.log('  Scan scheduler: 8:00 AM, 9:25 AM (quick picks), 9:35 AM, 12:00 PM ET (Mon-Fri)');
}

module.exports = { runScan, startScheduler, fetchQuotes, fetchHistorical };
