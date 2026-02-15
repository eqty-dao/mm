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
  
  const auth = Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');
  
  try {
    // Fetch data for both exchanges
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
    // Fetch bot status
    const statusRes = await fetch(`${API_BASE}/bot-orchestration/${botId}/status`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    const statusData = await statusRes.json();
    
    // Fetch order book
    const obRes = await fetch(`${API_BASE}/market-data/order-book`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ connector_name: connector, trading_pair: pair })
    });
    const orderBook = await obRes.json();
    
    // Fetch portfolio
    const portfolioRes = await fetch(`${API_BASE}/portfolio/state`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        account_names: [accountName],
        connector_names: [portfolioKey],
        skip_gateway: false,
        refresh: true
      })
    });
    const portfolioData = await portfolioRes.json();
    
    // Parse orders from logs (now tracks cancellations)
    const logs = statusData?.data?.general_logs || [];
    const orders = parseActiveOrdersFromLogs(logs);
    
    // Calculate metrics
    const bestBid = orderBook?.bids?.[0]?.price || 0;
    const bestAsk = orderBook?.asks?.[0]?.price || 0;
    const midPrice = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
    
    const balances = portfolioData?.[accountName]?.[portfolioKey] || [];
    const assets = calculateAssetMetrics(balances, midPrice);
    
    // Count orders by side (now case-insensitive)
    const buyOrders = orders.filter(o => o.side.toUpperCase() === 'BUY').length;
    const sellOrders = orders.filter(o => o.side.toUpperCase() === 'SELL').length;
    
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
    console.error(`Error fetching ${connector}:`, error);
    return getErrorMetrics();
  }
}

function parseActiveOrdersFromLogs(logs) {
  const createPattern = /Created (LIMIT_MAKER|LIMIT) (BUY|SELL) order (\S+) for ([\d.]+) EQTY-USDT at ([\d.]+)/;
  const cancelPattern = /Cancelled order (\S+)/;
  const fillPattern = /Filled ([\d.]+) out of ([\d.]+) of the (BUY|SELL) order (\S+)/;
  
  const activeOrders = new Map();
  const cancelledOrders = new Set();
  const filledOrders = new Set();
  
  // Process logs chronologically to track order lifecycle
  for (const log of logs) {
    const msg = log.msg || '';
    
    // Track created orders
    const createMatch = msg.match(createPattern);
    if (createMatch) {
      const [, type, side, orderId, amount, price] = createMatch;
      const priceLevel = parseFloat(price).toFixed(6);
      const key = `${side}_${priceLevel}`;
      
      activeOrders.set(key, { 
        side, 
        price: parseFloat(price),
        orderId,
        key
      });
      continue;
    }
    
    // Track cancelled orders
    const cancelMatch = msg.match(cancelPattern);
    if (cancelMatch) {
      const [, orderId] = cancelMatch;
      cancelledOrders.add(orderId);
      
      // Remove from active orders
      for (const [key, order] of activeOrders.entries()) {
        if (order.orderId === orderId) {
          activeOrders.delete(key);
          break;
        }
      }
      continue;
    }
    
    // Track filled orders
    const fillMatch = msg.match(fillPattern);
    if (fillMatch) {
      const [, filledAmount, totalAmount, side, orderId] = fillMatch;
      
      // If fully filled, remove from active
      if (parseFloat(filledAmount) === parseFloat(totalAmount)) {
        filledOrders.add(orderId);
        
        for (const [key, order] of activeOrders.entries()) {
          if (order.orderId === orderId) {
            activeOrders.delete(key);
            break;
          }
        }
      }
    }
  }
  
  // Return only orders that are still active
  return Array.from(activeOrders.values());
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

