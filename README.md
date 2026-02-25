# Docker & Hummingbot Monitor

Static dashboard hosted on GitHub Pages that shows:

- Docker status and active containers
- Balances for KuCoin and Gate.io
- Hummingbot trades for KuCoin and Gate.io (via bot history endpoint)
- **Bot status monitoring** with Markets, Assets, Orders, and inventory tracking
- **Zabbix integration** for real-time alerting and metrics

All sensitive credentials are handled **server-side** via a Vercel serverless proxy; the GitHub Pages site never sees or stores secrets.

---

## Architecture Overview

- **Frontend**: `eqty.html` served by GitHub Pages from this repo.
- **Proxy**: Vercel serverless function (`docker-proxy` project) that:
  - Receives requests from the frontend
  - Adds Docker/Hummingbot API credentials on the server side
  - Forwards to `https://hummingbot-api.eqty.pro`
  - Returns JSON back to the browser
- **Metrics API**: Serverless endpoint for Zabbix monitoring (`api/metrics.js`)
- **Backend**: Hummingbot API and Docker host, only reachable via authenticated calls from the Vercel proxy.

Frontend calls look like:

```text
GitHub Pages (browser)
    → Vercel proxy (with secrets)
        → https://hummingbot-api.eqty.pro/...
```

## Features

### Docker Tab
Shows whether Docker is running (via `/docker/running`).

Lists active containers with:
- Name
- Short ID
- Status
- Image

Auto-refresh every 120 seconds (configurable).

### KuCoin Tab
- **Bot Balance**: EQTY and USDT balances with UID
- **Bot Status**: Real-time bot monitoring showing:
  - Markets (exchange, pair, best bid/ask, mid price)
  - Assets (total/available balances, current/target values, inventory range, order adjust %)
  - Orders (recent orders with price, spread, amount)
  - Bot ID badge for identification
- **Bot Trades**: Fetches bot history from `/bot-orchestration/<KUCOIN_BOT_ID>/history`

Displays trades in a table:
- Time
- Pair
- Side (BUY/SELL pill)
- Price
- Quantity
- Market

### Gate.io Tab
Same layout as KuCoin tab with dedicated bot status monitoring and trade history.

---

## 1. Vercel Proxy Setup

This repo assumes you have a separate Vercel project that acts as an authenticated proxy to `https://hummingbot-api.eqty.pro`.

### 1.1 Create the proxy project

On your machine:

```bash
mkdir docker-proxy
cd docker-proxy
mkdir api
```

Create `api/docker.js`:

```javascript
// api/docker.js
export default async function handler(req, res) {
  // Support both origins during transition
  const allowedOrigins = [
    'https://zolpho.github.io',
    'https://eqty-dao.github.io'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint } = req.query;

  if (!endpoint) {
    return res.status(400).json({
      error: 'Missing endpoint parameter',
      usage: '?endpoint=/docker/running'
    });
  }

  const API_BASE = 'https://hummingbot-api.eqty.pro';
  const API_USER = process.env.API_USERNAME;
  const API_PASS = process.env.API_PASSWORD;

  if (!API_USER || !API_PASS) {
    return res.status(500).json({
      error: 'API credentials not configured'
    });
  }

  const targetUrl = `${API_BASE}${endpoint}`;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'),
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({
      error: 'Failed to fetch from Docker/Hummingbot API',
      message: error.message
    });
  }
}
```

Create `package.json`:

```json
{
  "name": "docker-proxy",
  "version": "1.0.0",
  "description": "Serverless proxy for Docker & Hummingbot API",
  "main": "api/docker.js",
  "scripts": {
    "dev": "vercel dev",
    "deploy": "vercel --prod"
  }
}
```

Create `.gitignore`:

```
.vercel
node_modules
.env
.env.local
```

Create a minimal `vercel.json`:

```json
{
  "version": 2
}
```

### 1.2 Deploy to Vercel

Install and log in:

```bash
npm install -g vercel
cd docker-proxy
vercel login
vercel
```

Follow prompts, then set environment variables:

```bash
vercel env add API_USERNAME production
vercel env add API_PASSWORD production
```

Deploy to production:

```bash
vercel --prod
```

You'll get an aliased URL like:

```
https://docker-proxy-eta.vercel.app
```

This is your `API_BASE` used by the frontend.

---

## 2. Frontend (this repo)

### 2.1 Docker & Hummingbot dashboard

The main page is `eqty.html` (`index.html` is a copy). It:

Defines the proxy base:

```javascript
const API_BASE = 'https://docker-proxy-eta.vercel.app/api/docker';
const REFRESH_INTERVAL = 120000; // 120 seconds
```

Uses a generic helper:

```javascript
async function fetchWithAuth(endpoint) {
  const url = `${API_BASE}?endpoint=${encodeURIComponent(endpoint)}`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.json();
}
```

Calls:
- `fetchWithAuth('/docker/running')`
- `fetchWithAuth('/docker/active-containers')`
- `fetchWithAuth('/bot-orchestration/<KUCOIN_BOT_ID>/status')`
- `fetchWithAuth('/bot-orchestration/<GATEIO_BOT_ID>/status')`
- `fetchWithAuth('/bot-orchestration/<KUCOIN_BOT_ID>/history?days=1&verbose=false&timeout=30')`
- `fetchWithAuth('/bot-orchestration/<GATEIO_BOT_ID>/history?days=1&verbose=false&timeout=30')`

### 2.2 GitHub Pages deployment

A GitHub Action deploys this repo to the `gh-pages` branch using `peaceiris/actions-gh-pages`.

Example workflow (`.github/workflows/deploy.yml`):

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

permissions:
  contents: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./
```

Configure GitHub Pages:
- Repo → Settings → Pages
- Source: `gh-pages` branch, root folder

Resulting URL:
`https://username.github.io/mm/eqty.html` or simply `https://username.github.io/mm/` (because of `index.html`)

---

## 3. Monitoring Setup (Zabbix Integration)

Monitor your market maker bots in real-time with Zabbix for automated alerting and metrics tracking.

### 3.1 Metrics API Endpoint

Create `api/metrics.js` in your `docker-proxy` folder for Zabbix to consume:

```javascript
// api/metrics.js
export default async function handler(req, res) {
  // CORS headers
  const allowedOrigins = [
    'https://zolpho.github.io',
    'https://eqty-dao.github.io'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_USER = process.env.API_USERNAME;
  const API_PASS = process.env.API_PASSWORD;

  if (!API_USER || !API_PASS) {
    return res.status(500).json({ error: 'API credentials not configured' });
  }

  const auth = Buffer.from(\`\${API_USER}:\${API_PASS}\`).toString('base64');

  try {
    const [kucoinData, gateioData] = await Promise.all([
      getExchangeMetrics('ea5d7b611fd1da6ad5bffd559bac3c0ed6ed11d0', 'kucoin', 'EQTY-USDT', 'cex_mm_kucoin', 'kucoin', auth),
      getExchangeMetrics('da6132e324292f6f7b914b58333808506f741db0', 'gate_io', 'EQTY-USDT', 'cex_mm_gate', 'gate_io', auth)
    ]);

    const metrics = {
      timestamp: Math.floor(Date.now() / 1000),
      kucoin: kucoinData,
      gateio: gateioData
    };

    return res.status(200).json(metrics);
  } catch (error) {
    console.error('Metrics error:', error);
    return res.status(500).json({
      error: 'Failed to fetch metrics',
      message: error.message,
      timestamp: Math.floor(Date.now() / 1000),
      kucoin: getErrorMetrics(),
      gateio: getErrorMetrics()
    });
  }
}

async function getExchangeMetrics(botId, connector, pair, accountName, portfolioKey, auth) {
  const API_BASE = 'https://hummingbot-api.eqty.pro';

  try {
    const [statusRes, obRes, portfolioRes] = await Promise.all([
      fetch(\`\${API_BASE}/bot-orchestration/\${botId}/status\`, {
        headers: { 'Authorization': \`Basic \${auth}\` }
      }),
      fetch(\`\${API_BASE}/market-data/order-book\`, {
        method: 'POST',
        headers: { 'Authorization': \`Basic \${auth}\`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector_name: connector, trading_pair: pair })
      }),
      fetch(\`\${API_BASE}/portfolio/state\`, {
        method: 'POST',
        headers: { 'Authorization': \`Basic \${auth}\`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_names: [accountName],
          connector_names: [portfolioKey],
          skip_gateway: false,
          refresh: true
        })
      })
    ]);

    const statusData = await statusRes.json();
    const orderBook = await obRes.json();
    const portfolioData = await portfolioRes.json();

    const logs = statusData?.data?.general_logs || [];
    const orders = parseOrdersFromLogs(logs);

    const bestBid = orderBook?.bids?.[0]?.price || 0;
    const bestAsk = orderBook?.asks?.[0]?.price || 0;
    const midPrice = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;

    const balances = portfolioData?.[accountName]?.[portfolioKey] || [];
    const assets = calculateAssetMetrics(balances, midPrice);

    const buyOrders = orders.filter(o => o.side === 'BUY').length;
    const sellOrders = orders.filter(o => o.side === 'SELL').length;

    return {
      ...assets,
      mid_price: midPrice,
      best_bid: bestBid,
      best_ask: bestAsk,
      active_orders_count: buyOrders + sellOrders,
      buy_orders_count: buyOrders,
      sell_orders_count: sellOrders,
      bot_running: (buyOrders + sellOrders > 0) ? 1 : 0,
      recently_active: statusData?.data?.recently_active ? 1 : 0
    };
  } catch (error) {
    console.error(\`Error fetching \${connector}:\`, error);
    return getErrorMetrics();
  }
}

function parseOrdersFromLogs(logs) {
  const orderPattern = /Created (LIMIT_MAKER|LIMIT) (BUY|SELL) order (\S+) for ([\d.]+) EQTY-USDT at ([\d.]+)/;
  const uniqueOrders = new Map();

  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    const msg = log.msg || '';
    const match = msg.match(orderPattern);

    if (match) {
      const [, , side, , , price] = match;
      const priceLevel = parseFloat(price).toFixed(6);
      const key = \`\${side}_\${priceLevel}\`;

      if (!uniqueOrders.has(key)) {
        uniqueOrders.set(key, { side, price: parseFloat(price) });
      }
    }
  }

  return Array.from(uniqueOrders.values());
}

function calculateAssetMetrics(balances, midPrice) {
  const eqtyBalance = balances.find(b => b.token === 'EQTY') || {};
  const usdtBalance = balances.find(b => b.token === 'USDT') || {};

  const eqtyTotal = parseFloat(eqtyBalance.units) || 0;
  const eqtyAvailable = parseFloat(eqtyBalance.available_units) || 0;
  const usdtTotal = parseFloat(usdtBalance.units) || 0;
  const usdtAvailable = parseFloat(usdtBalance.available_units) || 0;

  const eqtyValueUSDT = eqtyTotal * midPrice;
  const usdtValueUSDT = usdtTotal;
  const totalValueUSDT = eqtyValueUSDT + usdtValueUSDT;

  const eqtyCurrentPct = totalValueUSDT > 0 ? (eqtyValueUSDT / totalValueUSDT) * 100 : 0;
  const usdtCurrentPct = totalValueUSDT > 0 ? (usdtValueUSDT / totalValueUSDT) * 100 : 0;

  const targetValueUSDT = totalValueUSDT / 2;

  const eqtyOrderAdjust = eqtyValueUSDT > 0 ? (targetValueUSDT / eqtyValueUSDT) * 100 : 100;
  const usdtOrderAdjust = usdtValueUSDT > 0 ? (targetValueUSDT / usdtValueUSDT) * 100 : 100;

  const inventoryMin = 31.0;
  const inventoryMax = 69.0;

  return {
    eqty_current_pct: eqtyCurrentPct,
    usdt_current_pct: usdtCurrentPct,
    eqty_order_adjust: eqtyOrderAdjust,
    usdt_order_adjust: usdtOrderAdjust,
    is_balanced: (eqtyCurrentPct >= inventoryMin && eqtyCurrentPct <= inventoryMax) ? 1 : 0,
    total_value_usdt: totalValueUSDT,
    eqty_total: eqtyTotal,
    eqty_available: eqtyAvailable,
    usdt_total: usdtTotal,
    usdt_available: usdtAvailable
  };
}

function getErrorMetrics() {
  return {
    eqty_current_pct: 0,
    usdt_current_pct: 0,
    eqty_order_adjust: 100,
    usdt_order_adjust: 100,
    is_balanced: 0,
    total_value_usdt: 0,
    eqty_total: 0,
    eqty_available: 0,
    usdt_total: 0,
    usdt_available: 0,
    mid_price: 0,
    best_bid: 0,
    best_ask: 0,
    active_orders_count: 0,
    buy_orders_count: 0,
    sell_orders_count: 0,
    bot_running: 0,
    recently_active: 0
  };
}
```

**Deploy the metrics endpoint:**

```bash
cd docker-proxy
git add api/metrics.js
git commit -m "Add metrics endpoint for Zabbix"
vercel --prod
```

**Test the endpoint:**

```bash
curl https://docker-proxy-eta.vercel.app/api/metrics
```

Expected output:
```json
{
  "timestamp": 1771082986,
  "kucoin": {
    "eqty_current_pct": 49.93,
    "usdt_current_pct": 50.07,
    "is_balanced": 1,
    "bot_running": 1,
    "active_orders_count": 10,
    ...
  },
  "gateio": {
    ...
  }
}
```

### 3.2 Vercel Free Tier Optimization

> ⚠️ **Important:** Without this optimization, Zabbix will exhaust the Vercel free tier within days.

#### The Problem

Each Zabbix **HTTP Agent** item makes an independent HTTP request to Vercel. Every request triggers a serverless function **invocation**, which counts toward the monthly quota.

With the naive setup of 18 HTTP Agent items × 3 hosts × 1 poll/min:

```
18 items × 3 hosts × 1 req/min × 60 × 24 × 30 = ~2,332,800 invocations/month
```

The Vercel **Hobby (free) tier** allows only **100,000 invocations/month** — this blows past it in under 2 days.

#### The Solution — Dependent Items

Use **1 master HTTP Agent item** per host that fetches the full JSON payload once. All other items become **Dependent items** that extract their value locally using JSONPath preprocessing — no additional HTTP request, zero extra Vercel invocations.

```
Before: 18 HTTP Agent items → 18 Vercel calls per cycle
After:   1 HTTP Agent (master) + 18 Dependent items → 1 Vercel call per cycle
```

| Host | Before | After | Monthly saving |
|---|---|---|---|
| MM-Bot-KuCoin | 18 calls/min | 1 call/min | ~734,400 invocations |
| MM-Bot-GateIO | 18 calls/min | 1 call/min | ~734,400 invocations |
| MM-Bot-Binance | 18 calls/min | 1 call/min | ~734,400 invocations |
| **Total** | **54 calls/min** | **3 calls/min** | **~2,203,200/month** |

**Result: ~129,600 invocations/month — within the free tier limit. ✅**

#### Master Item Configuration

For each host, create one master item:

| Field | Value |
|---|---|
| **Name** | `Metrics Raw (Master)` |
| **Type** | HTTP agent |
| **Key** | `bot.metrics.raw` |
| **Value type** | Text |
| **URL** | `https://docker-proxy-eta.vercel.app/api/metrics` |
| **Update interval** | 1m |
| **History** | 1h (raw JSON, no need to keep longer) |
| **Trends** | Disabled |

> For `MM-Bot-Binance`, use `/api/metrics_test` instead.

#### Dependent Item Configuration

All other items are configured as:

| Field | Value |
|---|---|
| **Type** | Dependent item |
| **Master item** | `MM-Bot-<Exchange>: Metrics Raw (Master)` |
| **Preprocessing** | JSONPath (e.g. `$.kucoin.bot_running`) |

The JSONPath, triggers, graphs and value mappings remain **exactly the same** as before — only the item type changes from HTTP Agent to Dependent.

---

### 3.3 Zabbix Configuration

#### Create Hosts

1. **Data collection** → **Hosts** → **Create host**
2. Create two hosts:
   - **Name**: `MM-Bot-KuCoin`
   - **Groups**: `Market Makers` (create if doesn't exist)
   - **Interfaces**: None needed (HTTP agent)
3. Repeat for `MM-Bot-GateIO`

#### Items (18 per host)

> See [Section 3.2](#32-vercel-free-tier-optimization) — all items except the master should be **Dependent items**, not HTTP Agent, to avoid exhausting the Vercel free tier.

**Master item** (1 per host, HTTP Agent):
- **Key**: `bot.metrics.raw`
- **URL**: `https://docker-proxy-eta.vercel.app/api/metrics`
- **Update interval**: 1m

**Dependent items** (all others, Dependent type):
- **Master item**: `Metrics Raw (Master)`
- **Preprocessing**: JSONPath (e.g., `$.kucoin.eqty_current_pct`)

**Key Items:**
1. **EQTY Current %** - `$.kucoin.eqty_current_pct` (Units: %)
2. **USDT Current %** - `$.kucoin.usdt_current_pct` (Units: %)
3. **Is Balanced** - `$.kucoin.is_balanced` (0=Unbalanced, 1=Balanced)
4. **Bot Running** - `$.kucoin.bot_running` (0=Stopped, 1=Running)
5. **Total Value** - `$.kucoin.total_value_usdt` (Units: USDT)
6. **Active Orders** - `$.kucoin.active_orders_count`
7. **Mid Price** - `$.kucoin.mid_price` (Units: USDT)

For Gate.io, use `$.gateio.*` instead.

#### Create Triggers (8 per host)

**Critical Triggers:**
1. **Portfolio Critically Unbalanced**
   - Expression: `last(/MM-Bot-KuCoin/bot.eqty.pct)<31 or last(/MM-Bot-KuCoin/bot.eqty.pct)>69`
   - Severity: High
2. **Bot Stopped**
   - Expression: `last(/MM-Bot-KuCoin/bot.running)=0`
   - Severity: High

**Warning Triggers:**
3. **Approaching Imbalance** - EQTY% between 31-35% or 65-69%
4. **Order Count Imbalance** - Buy/sell orders differ by >2
5. **Large Value Change** - Portfolio changed by >100 USDT
6. **Few Active Orders** - <5 orders but >0

**Note:** Remove `%` from trigger names if item has Units configured to avoid double `%%`.

#### Create Graphs (7 per host)

1. **Portfolio Balance %** - EQTY% and USDT% over time
2. **Order Adjustment %** - Shows rebalancing needs
3. **Total Portfolio Value** - Value in USDT
4. **Active Orders** - Buy/sell order counts
5. **Price Monitoring** - Bid/mid/ask prices
6. **Token Balances** - EQTY and USDT amounts
7. **Bot Running Status** - Binary status timeline

#### Create Dashboard

**Monitoring** → **Dashboards** → **Create dashboard**

Widgets:
- Graph widgets for portfolio balance, orders, value
- Plain text widgets showing current metrics for both exchanges
- Problems widget for active alerts

### 3.4 Value Mappings

Create reusable value mappings:

**Data collection** → **Value mappings** → **Create value mapping**

1. **Bot Status**: 0=Stopped, 1=Running
2. **Balance Status**: 0=Unbalanced, 1=Balanced
3. **Yes/No**: 0=No, 1=Yes

Apply to respective items in **Value mapping** dropdown.

### 3.5 Alerts Setup

**Alerts** → **Actions** → **Trigger actions** → **Create action**

Configure email/Telegram/Slack notifications for:
- Critical: Portfolio unbalanced, bot stopped
- Warning: Approaching limits, order issues

---

## Exposed Metrics for Monitoring

The `window.eqtyBotMetrics` and `window.gateioMetrics` JavaScript objects expose:

- `eqty_current_pct` - Current EQTY percentage (31-69% is safe range)
- `usdt_current_pct` - Current USDT percentage
- `is_balanced` - Boolean (1=balanced, 0=unbalanced)
- `bot_running` - Boolean (1=has orders, 0=stopped)
- `eqty_order_adjust` - Order size adjustment % for EQTY
- `usdt_order_adjust` - Order size adjustment % for USDT
- `total_value_usdt` - Total portfolio value in USDT
- `active_orders_count` - Number of active orders
- `mid_price` - Current market mid price

These can be consumed by external monitoring systems via the `/api/metrics` endpoint.

---

## License

MIT

