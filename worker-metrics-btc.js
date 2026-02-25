// worker-metrics-btc.js
// Cloudflare Worker — BTC metrics endpoint (replaces Vercel api/metrics_test.js)
// Deploy as a Worker, bind secrets: API_USERNAME, API_PASSWORD

const ALLOWED_ORIGINS = [
  'https://zolpho.github.io',
  'https://eqty-dao.github.io',
  'https://eqty.me'
];

const API_BASE  = 'https://hummingbot-api.eqty.pro';
const BOT_ID    = '843b015973491f3e50405a3e5993d3a2a30c207c';
const CONNECTOR = 'kucoin';
const PAIR      = 'BTC-USDT';
const ACCOUNT   = 'cex_mm_binance';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type':                 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const { API_USERNAME: user, API_PASSWORD: pass } = env;
    if (!user || !pass) {
      return Response.json({ error: 'API credentials not configured' }, { status: 500, headers: corsHeaders });
    }

    const auth = btoa(`${user}:${pass}`);

    try {
      const data = await getBtcMetrics(auth);
      return Response.json(
        { timestamp: Math.floor(Date.now() / 1000), binance: data },
        { headers: corsHeaders }
      );
    } catch (error) {
      return Response.json(
        { error: error.message, timestamp: Math.floor(Date.now() / 1000), binance: getErrorMetrics() },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};

async function getBtcMetrics(auth) {
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  const [statusRes, obRes, portfolioRes] = await Promise.all([
    fetch(`${API_BASE}/bot-orchestration/${BOT_ID}/status`, { headers }),
    fetch(`${API_BASE}/market-data/order-book`, {
      method: 'POST', headers,
      body: JSON.stringify({ connector_name: CONNECTOR, trading_pair: PAIR })
    }),
    fetch(`${API_BASE}/portfolio/state`, {
      method: 'POST', headers,
      body: JSON.stringify({
        account_names:    [ACCOUNT],
        connector_names:  [CONNECTOR],
        skip_gateway:     false,
        refresh:          true
      })
    })
  ]);

  const [statusData, orderBook, portfolioData] = await Promise.all([
    statusRes.json(),
    obRes.json(),
    portfolioRes.json()
  ]);

  const logs      = statusData?.data?.general_logs || [];
  const orders    = parseActiveOrders(logs, PAIR);
  const bestBid   = orderBook?.bids?.[0]?.price || 0;
  const bestAsk   = orderBook?.asks?.[0]?.price || 0;
  const midPrice  = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
  const balances  = portfolioData?.[ACCOUNT]?.[CONNECTOR] || [];
  const assets    = calculateAssetMetrics(balances, midPrice);

  const buyOrders  = orders.filter(o => o.side.toUpperCase() === 'BUY').length;
  const sellOrders = orders.filter(o => o.side.toUpperCase() === 'SELL').length;

  return {
    ...assets,
    mid_price:           midPrice,
    best_bid:            bestBid,
    best_ask:            bestAsk,
    active_orders_count: buyOrders + sellOrders,
    buy_orders_count:    buyOrders,
    sell_orders_count:   sellOrders,
    bot_running:         statusData?.data?.recently_active ? 1 : 0,
    recently_active:     statusData?.data?.recently_active ? 1 : 0,
  };
}

function parseActiveOrders(logs, pair) {
  const escapedPair   = pair.replace('-', '\\-');
  const createPattern = new RegExp(`Created (LIMIT_MAKER|LIMIT) (BUY|SELL) order (\\S+) for ([\\d.]+) ${escapedPair} at ([\\d.]+)`);
  const cancelPattern = /Cancelled order (\S+)/;
  const fillPattern   = /Filled ([\d.]+) out of ([\d.]+) of the (BUY|SELL) order (\S+)/;

  const activeOrders    = new Map();
  const cancelledOrders = new Set();

  for (const log of logs) {
    const msg = log.msg || '';
    const cancelMatch = msg.match(cancelPattern);
    if (cancelMatch) cancelledOrders.add(cancelMatch[1]);
    const fillMatch = msg.match(fillPattern);
    if (fillMatch && parseFloat(fillMatch[1]) === parseFloat(fillMatch[2])) {
      cancelledOrders.add(fillMatch[4]);
    }
  }

  const recentLogs = logs.slice(-50);
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    const match = (recentLogs[i].msg || '').match(createPattern);
    if (match) {
      const [, , side, orderId, amount, price] = match;
      if (!cancelledOrders.has(orderId) && !activeOrders.has(orderId)) {
        activeOrders.set(orderId, { side, price: parseFloat(price), orderId, amount: parseFloat(amount) });
        if (activeOrders.size >= 15) break;
      }
    }
  }
  return Array.from(activeOrders.values());
}

function calculateAssetMetrics(balances, midPrice) {
  const btcBal   = balances.find(b => b.token === 'BTC')  || {};
  const usdtBal  = balances.find(b => b.token === 'USDT') || {};

  const btcTotal      = parseFloat(btcBal.units)            || 0;
  const btcAvailable  = parseFloat(btcBal.available_units)  || 0;
  const usdtTotal     = parseFloat(usdtBal.units)           || 0;
  const usdtAvailable = parseFloat(usdtBal.available_units) || 0;

  const btcValue   = btcTotal * midPrice;
  const totalValue = btcValue + usdtTotal;
  const btcPct     = totalValue > 0 ? (btcValue   / totalValue) * 100 : 0;
  const usdtPct    = totalValue > 0 ? (usdtTotal  / totalValue) * 100 : 0;
  const target     = totalValue / 2;

  return {
    btc_current_pct:   btcPct,
    usdt_current_pct:  usdtPct,
    btc_order_adjust:  btcValue  > 0 ? (target / btcValue)  * 100 : 100,
    usdt_order_adjust: usdtTotal > 0 ? (target / usdtTotal) * 100 : 100,
    is_balanced:       (btcPct >= 31 && btcPct <= 69) ? 1 : 0,
    total_value_usdt:  totalValue,
    btc_total:         btcTotal,
    btc_available:     btcAvailable,
    usdt_total:        usdtTotal,
    usdt_available:    usdtAvailable,
  };
}

function getErrorMetrics() {
  return {
    btc_current_pct: 0, usdt_current_pct: 0, btc_order_adjust: 100, usdt_order_adjust: 100,
    is_balanced: 0, total_value_usdt: 0, btc_total: 0, btc_available: 0,
    usdt_total: 0, usdt_available: 0, mid_price: 0, best_bid: 0, best_ask: 0,
    active_orders_count: 0, buy_orders_count: 0, sell_orders_count: 0,
    bot_running: 0, recently_active: 0,
  };
}

