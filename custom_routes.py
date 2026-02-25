import hmac, hashlib, base64, time, httpx
from fastapi import APIRouter, Query
router = APIRouter()

KUCOIN_KEY        = "your_key"
KUCOIN_SECRET     = "your_secret"
KUCOIN_PASSPHRASE = "your_passphrase"

@router.get("/kucoin/fills")
async def get_fills(symbol: str = "BTC-USDT", days: int = 1):
    now      = int(time.time() * 1000)
    start_at = now - days * 86400 * 1000
    endpoint = f"/api/v1/hf/fills?symbol={symbol}&startAt={start_at}&endAt={now}&limit=100"
    ts       = str(now)
    sign     = base64.b64encode(hmac.new(KUCOIN_SECRET.encode(), (ts + "GET" + endpoint).encode(), hashlib.sha256).digest()).decode()
    pphrase  = base64.b64encode(hmac.new(KUCOIN_SECRET.encode(), KUCOIN_PASSPHRASE.encode(), hashlib.sha256).digest()).decode()
    headers  = {
        "KC-API-KEY": KUCOIN_KEY, "KC-API-SIGN": sign,
        "KC-API-PASSPHRASE": pphrase, "KC-API-TIMESTAMP": ts,
        "KC-API-KEY-VERSION": "2"
    }
    async with httpx.AsyncClient() as client:
        r = await client.get(f"https://api.kucoin.com{endpoint}", headers=headers)
        return r.json()

