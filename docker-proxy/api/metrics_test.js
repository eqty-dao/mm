// api/metrics_test.js
// Standalone metrics endpoint for MM-Bot-Binance (BTC-USDT)
// Does NOT touch existing EQTY/KuCoin/GateIO logic

export default async function handler(req, res) {
  const allowedOrigins = [
    'https://zolpho.github.io',
    'https://eqty-dao.github.io',
    'https://eqty.me'
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

  const auth = Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');

  try {
    const binanceData = await getBtcMetrics(
      '843b015973491f3e50405a3e5993d3a2a30c207c',
      'binance',
      'BTC-USDT',
      'cex_mm_binance',
      'binance',
      auth
    );

    return res.status(200).json({
      timestamp: Math.floor(Date.now() / 1000),
      binance: binanceData
    });
  } catch (error) {
    console.error('BTC metrics error:', error);
    return res.status(500).json({
      error: 'Failed to fetch BTC metrics',
      message: error.message,
      timestamp: Math.floor(Date.now() / 1000),
      binance: getErrorMetrics()
    });
  }
}

async function getBtcMetrics(botId, connector, pair, accountName, portfolioKey, auth) {
  const API_BASE = 'https://hummingbot-api.eqty.pro';
  const BASE_TOKEN = 'BTC';

  try {
    const [statusRes, obRes, portfolioRes] = await Promise.all([
      fetch(`${API_BASE}/bot-orchestration/${botId}/status`, {
        headers: { 'Authorization': `Basic ${auth}` }
      }),
      fetch(`${API_BASE}/market-data/order-book`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector_name: connector, trading_pair: pair })
      }),
      fetch(`${API_BASE}/portfolio/state`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_names: [accountName],
          connector_names: [portfolioKey],
          skip_gateway: false,
          refresh: true
        })
      })
    ]);

    const [statusData, orderBook, portfolioData] = await Promise.all([
      statusRes.json(),
      obRes.json(),
      portfolioRes.json()
    ]);

    const logs = statusData?.data?.general_logs || [];
    const orders = parseActiveOrdersFromLogs(logs, pair);

    const bestBid = orderBook?.bids?.[0]?.price || 0;
    const bestAsk = orderBook?.asks?.[0]?.price || 0;
    const midPrice = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;

    const balances = portfolioData?.[accountName]?.[portfolioKey] || [];
    const assets = calculateAssetMetrics(balances, midPrice, BASE_TOKEN);

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
      bot_running:         (buyOrders + sellOrders > 0) ? 1 : 0,
      recently_active:     statusData?.data?.recently_active ? 1 : 0
    };
  } catch (error) {
    console.error(`Error fetching Binance BTC:`, error);
    return getErrorMetrics();
  }
}

function parseActiveOrdersFromLogs(logs, pair) {
  const escapedPair = pair.replace('-', '\\-');
  const createPattern = new RegExp(
    `Created (LIMIT_MAKER|LIMIT) (BUY|SELL) order (\\S+) for ([\\d.]+) ${escapedPair} at ([\\d.]+)`
  );
  const cancelPattern = /Cancelled order (\S+)/;
  const fillPattern   = /Filled ([\d.]+) out of ([\d.]+) of the (BUY|SELL) order (\S+)/;

  const activeOrders    = new Map();
  const cancelledOrders = new Set();

  for (const log of logs) {
    const msg = log.msg || '';
    const cancelMatch = msg.match(cancelPattern);
    if (cancelMatch) cancelledOrders.add(cancelMatch[1]);

    const fillMatch = msg.match(fillPattern);
    if (fillMatch) {
      const [, filledAmount, totalAmount, , orderId] = fillMatch;
      if (parseFloat(filledAmount) === parseFloat(totalAmount)) {
        cancelledOrders.add(orderId);
      }
    }
  }

  const recentLogs = logs.slice(-50);
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    const msg = recentLogs[i].msg || '';
    const createMatch = msg.match(createPattern);
    if (createMatch) {
      const [, , side, orderId, amount, price] = createMatch;
      if (cancelledOrders.has(orderId) || activeOrders.has(orderId)) continue;
      activeOrders.set(orderId, { side, price: parseFloat(price), orderId, amount: parseFloat(amount) });
      if (activeOrders.size >= 15) break;
    }
  }

  return Array.from(activeOrders.values());
}

function calculateAssetMetrics(balances, midPrice, baseToken = 'BTC') {
  const baseBalance  = balances.find(b => b.token === baseToken) || {};
  const usdtBalance  = balances.find(b => b.token === 'USDT') || {};

  const btcTotal      = parseFloat(baseBalance.units)           || 0;
  const btcAvailable  = parseFloat(baseBalance.available_units) || 0;
  const usdtTotal     = parseFloat(usdtBalance.units)           || 0;
  const usdtAvailable = parseFloat(usdtBalance.available_units) || 0;

  const btcValueUSDT   = btcTotal * midPrice;
  const totalValueUSDT = btcValueUSDT + usdtTotal;

  const btcCurrentPct  = totalValueUSDT > 0 ? (btcValueUSDT / totalValueUSDT) * 100 : 0;
  const usdtCurrentPct = totalValueUSDT > 0 ? (usdtTotal    / totalValueUSDT) * 100 : 0;

  const targetValueUSDT = totalValueUSDT / 2;
  const btcOrderAdjust  = btcValueUSDT > 0 ? (targetValueUSDT / btcValueUSDT) * 100 : 100;
  const usdtOrderAdjust = usdtTotal > 0    ? (targetValueUSDT / usdtTotal)    * 100 : 100;

  return {
    btc_current_pct:   btcCurrentPct,
    usdt_current_pct:  usdtCurrentPct,
    btc_order_adjust:  btcOrderAdjust,
    usdt_order_adjust: usdtOrderAdjust,
    is_balanced:       (btcCurrentPct >= 31.0 && btcCurrentPct <= 69.0) ? 1 : 0,
    total_value_usdt:  totalValueUSDT,
    btc_total:         btcTotal,
    btc_available:     btcAvailable,
    usdt_total:        usdtTotal,
    usdt_available:    usdtAvailable
  };
}

function getErrorMetrics() {
  return {
    btc_current_pct:     0,
    usdt_current_pct:    0,
    btc_order_adjust:    100,
    usdt_order_adjust:   100,
    is_balanced:         0,
    total_value_usdt:    0,
    btc_total:           0,
    btc_available:       0,
    usdt_total:          0,
    usdt_available:      0,
    mid_price:           0,
    best_bid:            0,
    best_ask:            0,
    active_orders_count: 0,
    buy_orders_count:    0,
    sell_orders_count:   0,
    bot_running:         0,
    recently_active:     0
  };
}

