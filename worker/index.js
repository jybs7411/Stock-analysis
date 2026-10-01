/**
 * PentAnalyst proxy — Cloudflare Worker
 *
 * 브라우저에서 Yahoo Finance를 직접 호출하면 CORS 때문에 막히므로,
 * 이 Worker가 대신 호출하고 CORS 헤더를 붙여 돌려줍니다.
 *
 * Endpoints
 *   GET /api/health                              -> { ok: true, service: "pentanalyst-proxy" }
 *   GET /api/chart?symbol=NVDA&range=1y          -> Yahoo v8 chart JSON 그대로 (일봉)
 *   GET /api/fundamentals?symbol=NVDA            -> 정리된 재무 지표 JSON
 *
 * 환경 변수 (wrangler.toml [vars] 또는 대시보드)
 *   ALLOWED_ORIGIN  허용할 Origin (예: https://jybs7411.github.io). 비우면 "*" 허용.
 */

const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;
const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y']);

// Yahoo crumb/cookie (isolate 메모리에 캐시)
let crumbCache = null;

function corsHeaders(request, env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || '*';
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = allowed === '*' ? '*' : (origin === allowed ? origin : allowed);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(body, status, request, env, cacheSeconds = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(request, env)
  };
  if (cacheSeconds > 0) headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}

function setCookieList(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function getCrumb(force = false) {
  const now = Date.now();
  if (!force && crumbCache && now - crumbCache.ts < 30 * 60 * 1000) return crumbCache;

  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = setCookieList(seed.headers).map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('yahoo cookie unavailable');

  const resp = await fetch(`${YAHOO}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await resp.text()).trim();
  if (!resp.ok || !crumb || crumb.includes('<')) throw new Error('yahoo crumb unavailable');

  crumbCache = { crumb, cookie, ts: now };
  return crumbCache;
}

const raw = v => (v && typeof v === 'object' ? v.raw : v);
const num = v => {
  const n = raw(v);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const CONSENSUS = {
  strong_buy: 'STRONG BUY',
  buy: 'BUY',
  hold: 'HOLD',
  underperform: 'UNDERPERFORM',
  sell: 'SELL'
};

export function mapFundamentals(symbol, result) {
  const price = result.price || {};
  const detail = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const fin = result.financialData || {};
  const profile = result.assetProfile || {};

  const roe = num(fin.returnOnEquity);
  const shortPct = num(stats.shortPercentOfFloat);
  return {
    symbol,
    name: price.shortName || price.longName || null,
    sector: profile.sector || null,
    industry: profile.industry || null,
    summary: profile.longBusinessSummary || null,
    marketCap: num(price.marketCap) ?? num(detail.marketCap),
    pe: num(detail.trailingPE),
    forwardPe: num(detail.forwardPE) ?? num(stats.forwardPE),
    peg: num(stats.pegRatio),
    pSales: num(detail.priceToSalesTrailing12Months),
    pBook: num(stats.priceToBook),
    roe: roe === null ? null : Number((roe * 100).toFixed(1)),
    shortFloat: shortPct === null ? null : Number((shortPct * 100).toFixed(2)),
    targetAvg: num(fin.targetMeanPrice),
    targetMin: num(fin.targetLowPrice),
    targetMax: num(fin.targetHighPrice),
    consensus: CONSENSUS[fin.recommendationKey] || null,
    dividendYield: num(detail.dividendYield)
  };
}

async function fetchQuoteSummary(symbol, retry = true) {
  const { crumb, cookie } = await getCrumb(!retry);
  const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile';
  const url = `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });

  if ((resp.status === 401 || resp.status === 403) && retry) {
    crumbCache = null;
    return fetchQuoteSummary(symbol, false);
  }
  const body = await resp.json().catch(() => null);
  if (resp.status === 404 || body?.quoteSummary?.error?.code === 'Not Found') return { notFound: true };
  if (!resp.ok) throw new Error(`yahoo quoteSummary ${resp.status}`);
  const result = body?.quoteSummary?.result?.[0];
  if (!result) return { notFound: true };
  return { result };
}

async function cached(request, ctx, ttl, producer) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  const res = await producer();
  if (cache && res.ok) {
    const copy = res.clone();
    const headers = new Headers(copy.headers);
    headers.set('Cache-Control', `public, max-age=${ttl}`);
    const stored = new Response(copy.body, { status: copy.status, headers });
    ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(request, stored)) : await cache.put(request, stored);
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, request, env);

    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'pentanalyst-proxy' }, 200, request, env);
    }

    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (url.pathname === '/api/chart' || url.pathname === '/api/fundamentals') {
      if (!SYMBOL_RE.test(symbol)) return json({ error: 'invalid symbol' }, 400, request, env);
    }

    try {
      if (url.pathname === '/api/chart') {
        const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1y';
        return await cached(request, ctx, 60, async () => {
          const upstream = await fetch(
            `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`,
            { headers: { 'User-Agent': UA } }
          );
          if (upstream.status === 404) return json({ error: 'not found' }, 404, request, env);
          if (!upstream.ok) return json({ error: `upstream ${upstream.status}` }, 502, request, env);
          const data = await upstream.json();
          if (data?.chart?.error?.code === 'Not Found' || !data?.chart?.result) {
            return json({ error: 'not found' }, 404, request, env);
          }
          return json(data, 200, request, env, 60);
        });
      }

      if (url.pathname === '/api/fundamentals') {
        return await cached(request, ctx, 6 * 3600, async () => {
          const out = await fetchQuoteSummary(symbol);
          if (out.notFound) return json({ error: 'not found' }, 404, request, env);
          return json(mapFundamentals(symbol, out.result), 200, request, env, 6 * 3600);
        });
      }
    } catch (err) {
      return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
    }

    return json({ error: 'not found' }, 404, request, env);
  }
};
