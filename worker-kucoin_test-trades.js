// worker-kucoin-trades.js
// Cloudflare Worker — fetches BTC-USDT trade history directly from KuCoin API
// Replaces bot-history endpoint so trades persist across strategy changes
// Secrets: KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE

const ALLOWED_ORIGINS = [
  'https://zolpho.github.io',
  'https://eqty-dao.github.io',
  'https://eqty.me'
];

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

    const { KUCOIN_API_KEY: key, KUCOIN_API_SECRET: secret, KUCOIN_API_PASSPHRASE: passphrase } = env;
    if (!key || !secret || !passphrase) {
      return Response.json({ error: 'KuCoin credentials not configured' }, { status: 500, headers: corsHeaders });
    }

    const url    = new URL(request.url);
    const days   = parseInt(url.searchParams.get('days') || '1');
    const symbol = url.searchParams.get('symbol') || 'BTC-USDT';

    const now     = Date.now();
    const startAt = now - days * 86400 * 1000;
    const endpoint = `/api/v1/hf/fills?symbol=${symbol}&startAt=${startAt}&endAt=${now}&limit=100`;
    const timestamp = String(now);

    // Build HMAC-SHA256 signature
    const strToSign  = timestamp + 'GET' + endpoint;
    const signKey    = await importKey(secret);
    const passKey    = await importKey(secret);
    const sign       = await hmacSign(signKey, strToSign);
    const signedPass = await hmacSign(passKey, passphrase);

    try {
      const response = await fetch(`https://api.kucoin.com${endpoint}`, {
        headers: {
          'KC-API-KEY':         key,
          'KC-API-SIGN':        sign,
          'KC-API-PASSPHRASE':  signedPass,
          'KC-API-TIMESTAMP':   timestamp,
          'KC-API-KEY-VERSION': '2',
          'Content-Type':       'application/json',
        }
      });

      const data = await response.json();

      if (data.code !== '200000') {
        return Response.json(
          { error: data.msg, code: data.code },
          { status: 400, headers: corsHeaders }
        );
      }

      // Normalize to match dashboard trade object format
      const trades = (data.data?.items || []).map(t => ({
        trade_timestamp: Math.floor(t.tradeTime / 1e6),   // nanoseconds → ms
        symbol:          t.symbol,
        trade_type:      t.side.toUpperCase(),             // "buy" → "BUY"
        price:           t.price,
        quantity:        t.size,
        market:          'kucoin',
        raw_json: {
          trade_fee: {
            percent: parseFloat(t.feeRate) || 0.001        // used by computePnlStats
          }
        }
      }));

      return Response.json(
        { trades, total: trades.length },
        { headers: corsHeaders }
      );
    } catch (error) {
      return Response.json(
        { error: error.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};

// ── Crypto helpers (Web Crypto API — available in Workers) ──────────────────
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function hmacSign(key, message) {
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

