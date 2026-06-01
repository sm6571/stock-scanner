const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'stock_scanner.db');
let db, SQL;

function wrapDb(rawDb) {
  function saveToFile() {
    const data = rawDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
  let dirty = false, saveTimer = null;
  function markDirty() {
    dirty = true;
    if (!saveTimer) {
      saveTimer = setTimeout(() => { if (dirty) { saveToFile(); dirty = false; } saveTimer = null; }, 3000);
    }
  }
  return {
    exec(sql) { rawDb.run(sql); markDirty(); },
    prepare(sql) {
      return {
        run(...params) {
          rawDb.run(sql, params); markDirty();
          const lastId = rawDb.exec('SELECT last_insert_rowid() as id')[0]?.values[0][0];
          return { lastInsertRowid: lastId, changes: rawDb.getRowsModified() };
        },
        get(...params) {
          const stmt = rawDb.prepare(sql); stmt.bind(params);
          if (stmt.step()) { const cols = stmt.getColumnNames(); const vals = stmt.get(); stmt.free(); const row = {}; cols.forEach((c,i) => row[c] = vals[i]); return row; }
          stmt.free(); return undefined;
        },
        all(...params) {
          const rows = []; const stmt = rawDb.prepare(sql); stmt.bind(params);
          while (stmt.step()) { const cols = stmt.getColumnNames(); const vals = stmt.get(); const row = {}; cols.forEach((c,i) => row[c] = vals[i]); rows.push(row); }
          stmt.free(); return rows;
        }
      };
    },
    transaction(fn) {
      return (...args) => {
        rawDb.run('BEGIN');
        try { const r = fn(...args); rawDb.run('COMMIT'); markDirty(); return r; }
        catch(e) { rawDb.run('ROLLBACK'); throw e; }
      };
    },
    save() { saveToFile(); },
    close() { saveToFile(); rawDb.close(); }
  };
}

async function initDatabase() {
  SQL = await initSqlJs();
  let rawDb;
  if (fs.existsSync(DB_PATH)) { rawDb = new SQL.Database(fs.readFileSync(DB_PATH)); }
  else { rawDb = new SQL.Database(); }
  db = wrapDb(rawDb);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_type TEXT DEFAULT 'manual',
      scanned_at TEXT DEFAULT (datetime('now')),
      stock_count INTEGER DEFAULT 0,
      result_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT DEFAULT '',
      price REAL DEFAULT 0,
      change_pct REAL DEFAULT 0,
      volume INTEGER DEFAULT 0,
      avg_volume INTEGER DEFAULT 0,
      volume_ratio REAL DEFAULT 0,
      atr REAL DEFAULT 0,
      atr_pct REAL DEFAULT 0,
      day_range_pct REAL DEFAULT 0,
      gap_pct REAL DEFAULT 0,
      market_cap REAL DEFAULT 0,
      sector TEXT DEFAULT '',
      score REAL DEFAULT 0,
      day_high REAL DEFAULT 0,
      day_low REAL DEFAULT 0,
      prev_close REAL DEFAULT 0,
      open_price REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      notes TEXT DEFAULT '',
      added_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_results_scan ON scan_results(scan_id, score DESC);
    CREATE INDEX IF NOT EXISTS idx_results_symbol ON scan_results(symbol);
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
  `);
  db.save();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { getDb, initDatabase };
