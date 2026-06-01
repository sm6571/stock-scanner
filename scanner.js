let yahooFinance = null;
async function getYF() {
  if (!yahooFinance) {
    const mod = await import('yahoo-finance2');
    yahooFinance = mod.default;
    yahooFinance.suppressNotices(['yahooSurvey', 'rippieTip']);
  }
  return yahooFinance;
}
const { getDb } = require('./database');
const TICKERS = require('./tickers');
const cron = require('node-cron');

const BATCH_SIZE = 20;
const BATCH_DELAY = 1500; // ms between batches to avoid rate limits

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchQuotes(symbols) {
  const yf = await getYF();
  const results = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await yf.quote(batch);
      const arr = Array.isArray(quotes) ? quotes : [quotes];
      results.push(...arr.filter(q => q && q.regularMarketPrice));
    } catch (err) {
      console.error(`Quote batch failed (${batch[0]}...):`, err.message);
    }
    if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
  }
  return results;
}

async function fetchHistorical(symbol, days = 20) {
  try {
    const yf = await getYF();
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days * 2));
    const result = await yf.chart(symbol, {
      period1: start.toISOString().split('T')[0],
      period2: end.toISOString().split('T')[0],
      interval: '1d'
    });
    return (result.quotes || []).slice(-days);
  } catch {
    return [];
  }
}

function calculateATR(bars) {
  if (bars.length < 2) return 0;
  let totalTR = 0;
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high || 0;
    const low = bars[i].low || 0;
    const prevClose = bars[i - 1].close || 0;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    totalTR += tr;
  }
  return totalTR / (bars.length - 1);
}

function scoreStock(data) {
  // Normalize each factor to ~0-100 range then weight
  const volRatioScore = Math.min(data.volume_ratio * 20, 100); // 5x = 100
  const atrPctScore = Math.min(data.atr_pct * 20, 100);       // 5% = 100
  const gapScore = Math.min(Math.abs(data.gap_pct) * 10, 100); // 10% = 100
  const rangeScore = Math.min(data.day_range_pct * 10, 100);   // 10% = 100

  return Math.round(
    (volRatioScore * 0.3) +
    (atrPctScore * 0.3) +
    (gapScore * 0.2) +
    (rangeScore * 0.2)
  );
}

async function runScan(scanType = 'manual') {
  console.log(`[${new Date().toISOString()}] Starting ${scanType} scan...`);
  const db = getDb();

  // 1. Fetch quotes for all tickers
  const quotes = await fetchQuotes(TICKERS);
  console.log(`  Fetched ${quotes.length} quotes`);

  // 2. Filter: price > $5, avg_volume > 500K
  const filtered = quotes.filter(q =>
    q.regularMarketPrice > 5 &&
    (q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0) > 500000
  );

  // 3. Calculate metrics for each stock
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
    const marketCap = q.marketCap || 0;

    const volumeRatio = Math.round((volume / avgVolume) * 100) / 100;
    const gapPct = prevClose > 0 ? Math.round(((open - prevClose) / prevClose) * 10000) / 100 : 0;
    const dayRangePct = open > 0 ? Math.round(((high - low) / open) * 10000) / 100 : 0;

    // Skip if volume ratio too low
    if (volumeRatio < 1.0) continue;

    const data = {
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: Math.round(price * 100) / 100,
      change_pct: Math.round(changePct * 100) / 100,
      volume,
      avg_volume: avgVolume,
      volume_ratio: volumeRatio,
      atr: 0,
      atr_pct: 0,
      day_range_pct: dayRangePct,
      gap_pct: gapPct,
      market_cap: marketCap,
      sector: q.sector || '',
      day_high: high,
      day_low: low,
      prev_close: prevClose,
      open_price: open,
      score: 0
    };

    results.push(data);
  }

  // 4. Fetch ATR for top candidates (by volume ratio) — limit to top 80 to save API calls
  const topCandidates = results
    .sort((a, b) => b.volume_ratio - a.volume_ratio)
    .slice(0, 80);

  for (let i = 0; i < topCandidates.length; i += 5) {
    const batch = topCandidates.slice(i, i + 5);
    await Promise.all(batch.map(async (stock) => {
      const bars = await fetchHistorical(stock.symbol, 15);
      if (bars.length >= 2) {
        stock.atr = Math.round(calculateATR(bars) * 100) / 100;
        stock.atr_pct = stock.price > 0 ? Math.round((stock.atr / stock.price) * 10000) / 100 : 0;
      }
    }));
    if (i + 5 < topCandidates.length) await sleep(500);
  }

  // 5. Score all candidates
  topCandidates.forEach(s => { s.score = scoreStock(s); });
  topCandidates.sort((a, b) => b.score - a.score);

  // 6. Save scan results
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
  // Pre-market: 8:00 AM ET (13:00 UTC)
  cron.schedule('0 13 * * 1-5', () => runScan('premarket'), { timezone: 'America/New_York' });
  // Market open: 9:35 AM ET
  cron.schedule('35 9 * * 1-5', () => runScan('open'), { timezone: 'America/New_York' });
  // Midday: 12:00 PM ET
  cron.schedule('0 12 * * 1-5', () => runScan('midday'), { timezone: 'America/New_York' });

  console.log('  Scan scheduler: 8:00 AM, 9:35 AM, 12:00 PM ET (Mon-Fri)');
}

module.exports = { runScan, startScheduler, fetchQuotes, fetchHistorical };
