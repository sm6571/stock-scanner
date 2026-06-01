const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getDb, initDatabase } = require('./database');
const { runScan, startScheduler, fetchQuotes } = require('./scanner');

const app = express();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'static')));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

const MAX_USERS = 2;
function userCount() { return getDb().prepare('SELECT COUNT(*) as count FROM users').get().count; }

// ── Auth routes ──
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'templates', 'login.html'));
});

app.post('/auth/register', authLimiter, (req, res) => {
  if (userCount() >= MAX_USERS) return res.status(403).json({ error: `Max ${MAX_USERS} accounts` });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const db = getDb();
  const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username.trim(), bcrypt.hashSync(password, 10));
  req.session.userId = result.lastInsertRowid;
  req.session.username = username.trim();
  res.json({ status: 'ok' });
});

app.post('/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username?.trim());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ status: 'ok' });
});

app.post('/auth/logout', (req, res) => { req.session.destroy(); res.json({ status: 'ok' }); });

app.get('/auth/status', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.userId),
    username: req.session?.username || null,
    needsSetup: userCount() < MAX_USERS
  });
});

// ── All routes below require auth ──
app.use(requireAuth);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));

// ── Scan API ──
app.get('/api/scan/latest', (req, res) => {
  const db = getDb();
  const scan = db.prepare('SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 1').get();
  if (!scan) return res.json({ scan: null, results: [] });

  const results = db.prepare(`
    SELECT * FROM scan_results WHERE scan_id = ? ORDER BY score DESC
  `).all(scan.id);

  res.json({ scan, results });
});

app.get('/api/scan/history', (req, res) => {
  const db = getDb();
  const scans = db.prepare('SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 20').all();
  res.json(scans);
});

app.get('/api/scan/:id', (req, res) => {
  const db = getDb();
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const results = db.prepare('SELECT * FROM scan_results WHERE scan_id = ? ORDER BY score DESC').all(scan.id);
  res.json({ scan, results });
});

app.post('/api/scan/run', async (req, res) => {
  try {
    const result = await runScan('manual');
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stock Detail ──
app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const quotes = await fetchQuotes([req.params.symbol.toUpperCase()]);
    if (quotes.length === 0) return res.status(404).json({ error: 'Symbol not found' });
    res.json(quotes[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Watchlist ──
app.get('/api/watchlist', async (req, res) => {
  const db = getDb();
  const uid = req.session.userId;
  const items = db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').all(uid);

  if (items.length === 0) return res.json([]);

  // Fetch live quotes for watchlist
  const symbols = items.map(i => i.symbol);
  try {
    const quotes = await fetchQuotes(symbols);
    const quoteMap = {};
    quotes.forEach(q => { quoteMap[q.symbol] = q; });

    const enriched = items.map(item => {
      const q = quoteMap[item.symbol];
      return {
        ...item,
        price: q?.regularMarketPrice || null,
        change_pct: q?.regularMarketChangePercent ? Math.round(q.regularMarketChangePercent * 100) / 100 : null,
        volume: q?.regularMarketVolume || null,
        name: q?.shortName || item.symbol
      };
    });
    res.json(enriched);
  } catch {
    res.json(items);
  }
});

app.post('/api/watchlist', (req, res) => {
  const { symbol, notes } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  const db = getDb();
  try {
    db.prepare('INSERT INTO watchlist (user_id, symbol, notes) VALUES (?, ?, ?)').run(req.session.userId, symbol.toUpperCase().trim(), notes || '');
    res.json({ status: 'ok' });
  } catch {
    res.status(409).json({ error: 'Already in watchlist' });
  }
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  getDb().prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').run(req.session.userId, req.params.symbol.toUpperCase());
  res.json({ status: 'ok' });
});

// ── Market Overview ──
app.get('/api/market', async (req, res) => {
  try {
    const quotes = await fetchQuotes(['SPY', 'QQQ', 'IWM', 'DIA', 'VIX']);
    const data = {};
    quotes.forEach(q => {
      data[q.symbol] = {
        price: Math.round((q.regularMarketPrice || 0) * 100) / 100,
        change_pct: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
        volume: q.regularMarketVolume || 0,
        state: q.marketState || 'CLOSED'
      };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3002;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  Stock Scanner running at http://localhost:${PORT}\n`);
    startScheduler();
    console.log('');
  });
}).catch(err => {
  console.error('Failed to init:', err);
  process.exit(1);
});
