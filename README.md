# Docker & Hummingbot Monitor

Static dashboard hosted on GitHub Pages that shows:

- Docker status and active containers
- Hummingbot trades for KuCoin (via bot history endpoint)
- Placeholder tab for Gate.io (ready to be wired to its bot)

All sensitive credentials are handled **server-side** via a Vercel serverless proxy; the GitHub Pages site never sees or stores secrets.

---

## Architecture Overview

- **Frontend**: `docker-status.html` served by GitHub Pages from this repo.
- **Proxy**: Vercel serverless function (`docker-proxy` project) that:
  - Receives requests from the frontend
  - Adds Docker/Hummingbot API credentials on the server side
  - Forwards to `https://hummingbot-api.eqty.pro`
  - Returns JSON back to the browser
- **Backend**: Hummingbot API and Docker host, only reachable via authenticated calls from the Vercel proxy.

Frontend calls look like:

```text
GitHub Pages (browser)
    → Vercel proxy (with secrets)
        → https://hummingbot-api.eqty.pro/...
```
Features
Docker Tab
Shows whether Docker is running (via /docker/running).

Lists active containers with:

Name

Short ID

Status

Image

Auto-refresh every 120 seconds (configurable).

KuCoin Tab
Fetches bot history from:

/bot-orchestration/<KUCOIN_BOT_ID>/history?days=1&verbose=false&timeout=30

Displays trades in a table:

Time

Pair

Side (BUY/SELL pill)

Price

Quantity

Market

Gate.io Tab
Same layout as KuCoin tab.

Currently wired to a placeholder endpoint; you only need to plug in the correct Gate.io bot ID and history path.

1. Vercel Proxy Setup
This repo assumes you have a separate Vercel project that acts as an authenticated proxy to https://hummingbot-api.eqty.pro.

1.1 Create the proxy project
On your machine:

```
mkdir docker-proxy
cd docker-proxy
mkdir api
```
Create api/docker.js:

```
// api/docker.js
export default async function handler(req, res) {
  const allowedOrigin = 'https://zolpho.github.io';  // your GitHub Pages origin

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
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
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'),
        'Accept': 'application/json'
      }
    });

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
Create package.json:

```
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
Create .gitignore:

```
.vercel
node_modules
.env
.env.local
```
Create a minimal vercel.json:

```
{
  "version": 2
}
```
1.2 Deploy to Vercel
Install and log in:

```
npm install -g vercel
cd docker-proxy
vercel login
vercel
```
Follow prompts, then set environment variables:

```
vercel env add API_USERNAME production
vercel env add API_PASSWORD production
```
Deploy to production:

```
vercel --prod
```
You’ll get an aliased URL like:

```
https://docker-proxy-eta.vercel.app
```
This is your API_BASE used by the frontend.

2. Frontend (this repo)
2.1 Docker & Hummingbot dashboard
The main page is docker-status.html. It:

Defines the proxy base:

```
const API_BASE = 'https://docker-proxy-eta.vercel.app/api/docker';
const REFRESH_INTERVAL = 120000; // 120 seconds
```
Uses a generic helper:

```
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

fetchWithAuth('/docker/running')

fetchWithAuth('/docker/active-containers')

fetchWithAuth('/bot-orchestration/<KUCOIN_BOT_ID>/history?days=1&verbose=false&timeout=30')

fetchWithAuth('/bot-orchestration/<GATEIO_BOT_ID>/history?days=1&verbose=false&timeout=30') (once you set it up)

2.2 GitHub Pages deployment
A GitHub Action deploys this repo to the gh-pages branch using peaceiris/actions-gh-pages.
No config file or secrets are generated in the workflow anymore.

Example workflow (.github/workflows/deploy.yml):

```
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

Repo → Settings → Pages

Source: gh-pages branch, root folder

Resulting URL:
https://<your-username>.github.io/money_maker/docker-status.html
