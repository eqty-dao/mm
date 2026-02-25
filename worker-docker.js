// worker-docker.js
// Cloudflare Worker — generic proxy for Hummingbot API (replaces Vercel api/docker.js)
// Deploy as a Worker, bind secrets: API_USERNAME, API_PASSWORD

const ALLOWED_ORIGINS = [
  'https://zolpho.github.io',
  'https://eqty-dao.github.io',
  'https://eqty.me'
];

const API_BASE = 'https://hummingbot-api.eqty.pro';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');

    if (!endpoint) {
      return Response.json(
        { error: 'Missing endpoint parameter', usage: '?endpoint=/docker/running' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { API_USERNAME: user, API_PASSWORD: pass } = env;
    if (!user || !pass) {
      return Response.json(
        { error: 'API credentials not configured' },
        { status: 500, headers: corsHeaders }
      );
    }

    const auth = btoa(`${user}:${pass}`);
    const targetUrl = `${API_BASE}/${endpoint.replace(/^\//, '')}`;

    try {
      const fetchOptions = {
        method: request.method,
        headers: {
          'Authorization':  `Basic ${auth}`,
          'Accept':         'application/json',
          'Content-Type':   'application/json',
        },
      };

      if (request.method === 'POST' || request.method === 'PUT') {
        fetchOptions.body = await request.text();
      }

      const response = await fetch(targetUrl, fetchOptions);
      const data = await response.json();

      return Response.json(data, {
        status: response.status,
        headers: corsHeaders,
      });
    } catch (error) {
      return Response.json(
        { error: 'Failed to fetch from Hummingbot API', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};

