// api/docker.js
export default async function handler(req, res) {
  // Support both origins during transition
  const allowedOrigins = [
    'https://zolpho.github.io',
    'https://eqty-dao.github.io',
    'https://eqty.me'
  ];

  // Check if request origin is allowed
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Default to first origin if no match (fallback)
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

  const targetUrl = `${API_BASE}/${endpoint.replace(/^\//, '')}`;

  try {
    // Build fetch options
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'),
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    // Forward body for POST/PUT requests
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

