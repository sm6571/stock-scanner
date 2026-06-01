# Stock Scanner

Daily stock screener for scalping — finds high-volatility, high-volume stocks using Yahoo Finance data.

## Quick Start

```bash
cd stock-scanner
npm install
npm start
```

Open **http://localhost:3002** and click **🔍 Scan** to run your first scan.

## Docker

```bash
docker compose up -d --build
```

## Features

- **Scalp Score** — Composite score (0-100) based on volume ratio, ATR%, gap%, and intraday range
- **~250 Liquid Stocks** — Scans S&P 500 + popular high-volume tickers
- **Market Overview** — SPY, QQQ, IWM, DIA, VIX at a glance
- **Filters** — Sort by score/volume/ATR/gap, filter by sector, min price, min score
- **Watchlist** — Save tickers, see live quotes
- **Scan History** — Browse past scan results
- **Auto Scans** — Scheduled at 8:00 AM, 9:35 AM, 12:00 PM ET (Mon-Fri)
- **Dark/Light Theme** — Toggle with 🌓

## Scoring

```
Score = (Volume Ratio × 0.3) + (ATR% × 0.3) + (Gap% × 0.2) + (Day Range% × 0.2)
```

Each factor normalized to 0-100, then weighted. Higher = more scalp-friendly.

**Minimum filters:** Price > $5, Avg Volume > 500K, Volume Ratio > 1.0

## Data Source

Uses Yahoo Finance (unofficial `yahoo-finance2` npm package). Data may be delayed 15 minutes.
Not suitable for real-time scalping decisions — use as a **watchlist generator**.

## Ports

| App | Port |
|-----|------|
| Trading Journal | 5000 |
| RSS Reader | 3001 |
| Stock Scanner | 3002 |
