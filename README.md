# Personal Portfolio Tracker

Local-first dashboard for tracking your personal financial position across
Trade Republic, NBG (National Bank of Greece), Greek T-Bills, and cash —
with live prices, automated sync, and per-position cost basis.

## Stack

- **Next.js 16** (App Router) + React 19 + Tailwind v4 + shadcn/ui — dashboard
- **Recharts** + Motion — charts and animations
- **Playwright** (Chromium persistent profile) — NBG i-Bank scraper
- **pytr** (Python) — Trade Republic WebSocket API
- **JSON files** — single source of truth (`data/portfolio.json` + `data/events.jsonl`)

## Live data sources

| Asset class | Source | Update cadence |
|---|---|---|
| ETFs / stocks (EUR-quoted) | Yahoo Finance v8 chart | 60s cache |
| ETFs (LSE / USD-quoted) | Stooq CSV | 60s cache |
| Crypto | CoinGecko | 60s cache |
| EUR/USD FX | ECB / frankfurter.app | 1h cache |
| ECB Deposit Facility Rate | ECB SDW API | 24h cache |
| Greek T-bill yields | PDMA (ΟΔΔΗΧ) HTML scrape | 24h cache |
| Trade Republic positions / cash | pytr WebSocket | on demand |
| NBG balances | Playwright scrape | on demand |

## Quick start

```bash
# 1. Node deps
npm install
npx playwright install chromium

# 2. Python deps for pytr
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Configure
cp .env.example .env.local
# … edit .env.local with your NBG + TR creds + (optional) SMTP

# 4. One-time TR login (interactive, ~30s — SMS/push 2FA)
npm run sync:tr:setup

# 5. Run dashboard
npm run dev
# → http://localhost:3000
```

## Sync

```bash
npm run sync:tr               # silent until pytr session expires
npm run sync:nbg              # opens headless Chromium; needs OTP from Viber
npm run sync:tr:transactions  # full TR timeline (645+ events) → data/tr-transactions.jsonl
npm run sync:all              # both, sequentially
```

Or trigger from the dashboard: click the **Sync** button in the header.
When NBG asks for an OTP, an OTP modal appears in the UI — paste the code
from Viber and submit.

## Auth lifecycle

- **TR (pytr):** session lasts weeks. When it expires, the dashboard shows
  "Trade Republic — re-auth needed" and you re-run `npm run sync:tr:setup`.
- **NBG:** Viber-delivered OTP every login session. The UI prompts you;
  enter the code from Viber. The persistent Chromium profile keeps cookies
  alive between same-day runs (NBG sometimes accepts password-only).

## Data layout

```text
data/
├── portfolio.json          single source of truth
├── events.jsonl            append-only change log
├── tr-transactions.jsonl   full TR timeline (635 events on first sync)
├── prices.json             price cache (60s)
├── fx.json                 EUR/USD cache (1h)
├── ecb.json                ECB rate cache (24h)
├── pdma.json               PDMA T-bill data (24h)
├── nbg/profile/            persistent Chromium profile (cookies, localStorage)
├── nbg/logs/               sync screenshots (debug)
├── sync/state.json         current sync status (consumed by web UI)
└── imports/                source documents (CSVs, PDFs)
```

All under `data/` is git-ignored.

## Privacy

- Hide-numbers toggle (eye icon, `⌘/Ctrl + .`) blurs every numeric value
  on the page — useful for screenshots / screen-sharing.
- All credentials and balances stay local. No cloud storage, no telemetry.

## Docker

```bash
docker compose up -d                    # dashboard at :3000
docker compose run --rm app pytr login  # one-time TR login
docker compose exec app npm run sync:all
```

The image bundles Node 22, Python 3, pytr, and Playwright/Chromium. See
`Dockerfile` and `compose.yaml` for details.

## JSON API

Read-only summary + sync triggers, suitable for embedding in self-hosted
dashboards (e.g. [Glance](https://github.com/glanceapp/glance)).

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/summary` | GET | Net worth, P/L, allocation by source, FX, ECB rate |
| `/api/sync` | GET | Current sync state (idle / running / needs_otp / success / error) |
| `/api/sync` | POST | Body `{ "source": "tr"\|"nbg"\|"all" }` to trigger a sync |
| `/api/sync/otp` | POST | Body `{ "source": "tr"\|"nbg", "code": "123456" }` |
| `/api/prices` | GET | Live prices + FX (cached 60s; pass `?force=1` to bust) |
| `/api/tbills` | GET | Greek T-bill auction calendar + yields (PDMA scrape) |

Auth: set `PORTFOLIO_API_TOKEN` in `.env.local` and pass it via `?token=…`,
`x-api-token: …`, or `Authorization: Bearer …`. With no token configured,
the endpoints are open — keep the dashboard on localhost or behind a tunnel.

### Glance widget recipe

Drop this into your Glance config:

```yaml
- type: custom-api
  title: Net worth
  cache: 5m
  url: http://portfolio-tracker:3000/api/summary?token=YOUR_TOKEN
  template: |
    <div style="font-size: 28px; font-weight: 600;">
      €{{ printf "%.0f" .JSON.Float "totalEur" | trim }}
    </div>
    <div style="opacity: 0.7;">
      P/L {{ if gt (.JSON.Float "gainEur") 0.0 }}+{{ end }}€{{ printf "%.0f" .JSON.Float "gainEur" }}
      ({{ printf "%.1f" (multiply (.JSON.Float "gainPct") 100.0) }}%)
    </div>
```

## Why no SQLite?

For ~30 assets and a few hundred transactions, SQLite would be **slower** than
the current setup, not faster. Reasons we use plain JSON files:

- Whole portfolio fits in a single read of one tiny file (`portfolio.json` is
  <10 KB). Loading it into memory is faster than parsing SQL queries against
  an indexed DB.
- Transactions append-only as JSONL → trivially diffable, recoverable, and
  rsync-able. SQLite WAL adds binary noise.
- Git-friendly: every change is a one-line diff in `events.jsonl`.
- No migration story to maintain.
- Backups = copy the `data/` folder.

If the dataset grew to thousands of positions or millions of price ticks,
SQLite (or DuckDB for analytics) would start to win. Until then it's pure
overhead.

## License

Personal use. No warranties.
