/**
 * PentAnalyst proxy — Cloudflare Worker
 *
 * 브라우저에서 Yahoo Finance를 직접 호출하면 CORS 때문에 막히므로,
 * 이 Worker가 대신 호출하고 CORS 헤더를 붙여 돌려줍니다.
 *
 * Endpoints
 *   GET /api/health                              -> { ok: true, service: "pentanalyst-proxy" }
 *   GET /api/chart?symbol=NVDA&range=1y&interval=1d -> Yahoo v8 chart JSON 그대로 (interval: 1d | 1wk | 1mo)
 *   GET /api/spark?symbols=SPY,QQQ&range=3mo&interval=1d -> 여러 종목의 종가 시계열을 한 번에 {SYM:{t,c,prev,price,currency}} (최대 120종목)
 *   GET /api/quotes?symbols=AAPL,MSFT            -> 여러 종목 현재 시세·시가총액·등락률 (최대 60종목)
 *   GET /api/search?q=basf                       -> 회사명/티커 검색 (전 세계 거래소) [{symbol,name,exchange,type}]
 *   GET /api/fundamentals?symbol=NVDA            -> 정리된 재무 지표 JSON
 *   GET /api/deep?symbol=NVDA                    -> 실적·재무·애널리스트·수급·배당·뉴스 (심층 분석용)
 *   GET /api/calendar?type=earnings|economic|ipo|splits&from=YYYY-MM-DD&to=YYYY-MM-DD -> 야후 금융 달력 {type,from,to,items[]} (기간 최대 70일)
 *
 * 환경 변수 (wrangler.toml [vars] 또는 대시보드)
 *   ALLOWED_ORIGIN  허용할 Origin (예: https://jybs7411.github.io). 비우면 "*" 허용.
 */

const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,15}$/;
// 분봉: 1m 은 최근 7일(range 5d 이하), 2m~90m 은 최근 60일(range 1mo 이하)까지만 Yahoo 가 제공
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d', '1wk', '1mo']);
const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY']);

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

// 비율(0.123) -> 퍼센트 숫자(12.3). 값이 없으면 null
const pct = (v, digits = 1) => {
  const n = num(v);
  return n === null ? null : Number((n * 100).toFixed(digits));
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
    // ---- 기존 키 (하위 호환: 이름·의미 변경 금지) ----
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
    dividendYield: num(detail.dividendYield),

    // ---- 스크리너용 추가 키 (값이 없으면 null, 비율은 12.3 = 12.3%) ----
    beta: num(detail.beta) ?? num(stats.beta),
    dividendRate: num(detail.dividendRate),
    dividendYieldPct: pct(detail.dividendYield, 2),
    payoutRatio: pct(detail.payoutRatio),
    roa: pct(fin.returnOnAssets),
    grossMargin: pct(fin.grossMargins),
    opMargin: pct(fin.operatingMargins),
    profitMargin: pct(fin.profitMargins),
    revGrowth: pct(fin.revenueGrowth),
    epsGrowth: pct(fin.earningsGrowth),
    debtToEquity: num(fin.debtToEquity), // Yahoo는 퍼센트로 줌 (150 = 150%)
    currentRatio: num(fin.currentRatio),
    quickRatio: num(fin.quickRatio),
    freeCashflow: num(fin.freeCashflow),
    totalRevenue: num(fin.totalRevenue),
    recMean: num(fin.recommendationMean), // 1(적극 매수) ~ 5(적극 매도)
    numAnalysts: num(fin.numberOfAnalystOpinions),
    insiderPct: pct(stats.heldPercentInsiders),
    instPct: pct(stats.heldPercentInstitutions),
    floatShares: num(stats.floatShares),
    sharesOutstanding: num(stats.sharesOutstanding),
    avgVolume: num(detail.averageVolume),
    country: profile.country || null,
    exchange: price.exchangeName || null,
    currency: price.currency || null,
    financialCurrency: fin.financialCurrency || null, // 재무제표 통화(ADR 등은 가격 통화와 다를 수 있음)
    epsTrailing: num(stats.trailingEps),
    epsForward: num(stats.forwardEps)
  };
}

const BASIC_MODULES = 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile';
const DEEP_MODULES = [
  'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'calendarEvents',
  'earnings', 'earningsHistory', 'earningsTrend', 'recommendationTrend', 'upgradeDowngradeHistory',
  'majorHoldersBreakdown', 'institutionOwnership', 'insiderTransactions', 'netSharePurchaseActivity'
].join(',');

async function fetchQuoteSummary(symbol, modules = BASIC_MODULES, retry = true) {
  const { crumb, cookie } = await getCrumb(!retry);
  const url = `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookie } });

  if ((resp.status === 401 || resp.status === 403) && retry) {
    crumbCache = null;
    return fetchQuoteSummary(symbol, modules, false);
  }
  const body = await resp.json().catch(() => null);
  if (resp.status === 404 || body?.quoteSummary?.error?.code === 'Not Found') return { notFound: true };
  if (!resp.ok) throw new Error(`yahoo quoteSummary ${resp.status}`);
  const result = body?.quoteSummary?.result?.[0];
  if (!result) return { notFound: true };
  return { result };
}

// ---- deep analysis mapping ----
const iso = v => {
  const n = num(v);
  return n === null ? null : new Date(n * 1000).toISOString().slice(0, 10);
};

export function mapDeep(symbol, r, news = []) {
  const fin = r.financialData || {};
  const stats = r.defaultKeyStatistics || {};
  const detail = r.summaryDetail || {};
  const cal = r.calendarEvents || {};
  const earn = r.earnings || {};
  const holders = r.majorHoldersBreakdown || {};
  const netIns = r.netSharePurchaseActivity || {};

  const earningsDates = (cal.earnings && cal.earnings.earningsDate) || [];
  const history = ((r.earningsHistory && r.earningsHistory.history) || []).map(h => ({
    quarter: iso(h.quarter),
    epsActual: num(h.epsActual),
    epsEstimate: num(h.epsEstimate),
    surprisePct: pct(h.surprisePercent)
  }));
  const trend = ((r.earningsTrend && r.earningsTrend.trend) || []).map(x => ({
    period: x.period,
    endDate: x.endDate || null,
    epsAvg: num(x.earningsEstimate && x.earningsEstimate.avg),
    revenueAvg: num(x.revenueEstimate && x.revenueEstimate.avg),
    revenueGrowth: pct(x.revenueEstimate && x.revenueEstimate.growth),
    epsGrowth: pct(x.earningsEstimate && x.earningsEstimate.growth)
  }));
  const chart = earn.financialsChart || {};

  return {
    symbol,
    earnings: {
      nextDate: earningsDates.length ? iso(earningsDates[0]) : null,
      history,
      trend
    },
    financials: {
      totalRevenue: num(fin.totalRevenue),
      revenueGrowth: pct(fin.revenueGrowth),
      earningsGrowth: pct(fin.earningsGrowth),
      grossMargin: pct(fin.grossMargins),
      operatingMargin: pct(fin.operatingMargins),
      profitMargin: pct(fin.profitMargins),
      totalCash: num(fin.totalCash),
      totalDebt: num(fin.totalDebt),
      debtToEquity: num(fin.debtToEquity),
      currentRatio: num(fin.currentRatio),
      quickRatio: num(fin.quickRatio),
      freeCashflow: num(fin.freeCashflow),
      operatingCashflow: num(fin.operatingCashflow),
      returnOnAssets: pct(fin.returnOnAssets),
      returnOnEquity: pct(fin.returnOnEquity),
      beta: num(detail.beta) ?? num(stats.beta),
      yearly: (chart.yearly || []).map(y => ({ year: y.date, revenue: num(y.revenue), earnings: num(y.earnings) })),
      quarterly: (chart.quarterly || []).map(q => ({ quarter: q.date, revenue: num(q.revenue), earnings: num(q.earnings) }))
    },
    analysts: {
      count: num(fin.numberOfAnalystOpinions),
      trend: ((r.recommendationTrend && r.recommendationTrend.trend) || []).map(x => ({
        period: x.period, strongBuy: x.strongBuy, buy: x.buy, hold: x.hold, sell: x.sell, strongSell: x.strongSell
      })),
      changes: ((r.upgradeDowngradeHistory && r.upgradeDowngradeHistory.history) || []).slice(0, 8).map(h => ({
        date: iso(h.epochGradeDate), firm: h.firm || null, from: h.fromGrade || null, to: h.toGrade || null, action: h.action || null
      }))
    },
    ownership: {
      insidersPct: pct(holders.insidersPercentHeld),
      institutionsPct: pct(holders.institutionsPercentHeld),
      institutionsFloatPct: pct(holders.institutionsFloatPercentHeld),
      institutionsCount: num(holders.institutionsCount),
      topInstitutions: ((r.institutionOwnership && r.institutionOwnership.ownershipList) || []).slice(0, 5).map(o => ({
        org: o.organization || null, pct: pct(o.pctHeld, 2), position: num(o.position), reportDate: iso(o.reportDate)
      })),
      insiderTransactions: ((r.insiderTransactions && r.insiderTransactions.transactions) || []).slice(0, 8).map(x => ({
        date: iso(x.startDate), name: x.filerName || null, relation: x.filerRelation || null,
        text: x.transactionText || null, shares: num(x.shares), value: num(x.value)
      })),
      netInsider: {
        period: netIns.period || null,
        buyShares: num(netIns.buyInfoShares),
        sellShares: num(netIns.sellInfoShares),
        netShares: num(netIns.netInfoShares)
      }
    },
    dividends: {
      yield: pct(detail.dividendYield, 2),
      rate: num(detail.dividendRate),
      exDate: iso(detail.exDividendDate),
      payoutRatio: pct(detail.payoutRatio)
    },
    news
  };
}

async function fetchNews(symbol) {
  try {
    const resp = await fetch(`${YAHOO}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`, { headers: { 'User-Agent': UA } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.news || []).slice(0, 8).map(n => ({
      title: n.title || null,
      publisher: n.publisher || null,
      link: typeof n.link === 'string' && /^https?:\/\//.test(n.link) ? n.link : null,
      time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null
    })).filter(n => n.title);
  } catch (e) {
    return [];
  }
}

// ---- symbol search (회사명 → 티커) ----
export function mapSearch(data) {
  const out = [];
  const seen = new Set();
  for (const q of (data && data.quotes) || []) {
    const symbol = typeof q.symbol === 'string' ? q.symbol.toUpperCase() : '';
    if (!SYMBOL_RE.test(symbol) || seen.has(symbol)) continue;
    if (!SEARCH_TYPES.has(q.quoteType)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      name: q.shortname || q.longname || null,
      exchange: q.exchDisp || q.exchange || null,
      type: q.quoteType,
      sector: q.sectorDisp || q.sector || null
    });
  }
  return out;
}

async function searchSymbols(query) {
  const resp = await fetch(
    `${YAHOO}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false`,
    { headers: { 'User-Agent': UA } }
  );
  if (!resp.ok) throw new Error(`yahoo search ${resp.status}`);
  return mapSearch(await resp.json());
}

// ---- 여러 종목 한 번에: 종가 시계열(spark) / 시세(quotes) ----
function chartToSpark(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) return null;
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const t = r.timestamp || [], c = q.close || [];
  const meta = r.meta || {};
  const tt = [], cc = [];
  for (let i = 0; i < t.length; i++) if (c[i] !== null && c[i] !== undefined && Number.isFinite(c[i])) { tt.push(t[i]); cc.push(c[i]); }
  if (!cc.length) return null;
  return { t: tt, c: cc, prev: num(meta.chartPreviousClose), price: num(meta.regularMarketPrice), currency: meta.currency || null };
}

export function mapSpark(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;

  // 1) 신규 Yahoo Finance spark 포맷: { "AAPL": { timestamp, close, fulldayPrice, fulldayChange, ... }, ... }
  Object.keys(data).forEach(sym => {
    if (sym === 'spark' || sym === 'error') return;
    const item = data[sym];
    if (!item || !Array.isArray(item.timestamp) || !Array.isArray(item.close)) return;
    const t = item.timestamp, c = item.close;
    const tt = [], cc = [];
    for (let i = 0; i < t.length; i++) {
      if (c[i] !== null && c[i] !== undefined && Number.isFinite(c[i])) {
        tt.push(t[i]);
        cc.push(c[i]);
      }
    }
    if (cc.length) {
      const price = num(item.fulldayPrice) ?? cc[cc.length - 1];
      const change = num(item.fulldayChange);
      const prev = (price !== null && change !== null) ? price - change : (num(item.chartPreviousClose) ?? num(item.previousClose));
      out[sym] = {
        t: tt,
        c: cc,
        prev,
        price,
        currency: item.currency || null
      };
    }
  });

  // 2) 레거시 v8 chart/spark 응답 포맷 호환: { spark: { result: [...] } }
  const results = (data && data.spark && data.spark.result) || [];
  results.forEach(item => {
    const sym = item && item.symbol;
    const resp = item && item.response && item.response[0];
    if (!sym || !resp || out[sym]) return;
    const m = chartToSpark({ chart: { result: [resp] } });
    if (m) out[sym] = m;
  });

  return out;
}

async function fetchSparkAll(symbols, range, interval) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  await Promise.all(chunks.map(async chunk => {
    try {
      const resp = await fetch(`${YAHOO}/v8/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=${range}&interval=${interval}`, { headers: { 'User-Agent': UA } });
      if (resp.ok) Object.assign(out, mapSpark(await resp.json()));
    } catch (e) { /* 아래 개별 조회로 보충 */ }
  }));
  // spark 가 못 준 종목은 개별 차트로 보충 (Workers 무료 플랜 서브요청 한도를 고려해 최대 25개)
  const missing = symbols.filter(s => !out[s]).slice(0, 25);
  await Promise.all(missing.map(async sym => {
    try {
      const resp = await fetch(`${YAHOO}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`, { headers: { 'User-Agent': UA } });
      if (resp.ok) { const m = chartToSpark(await resp.json()); if (m) out[sym] = m; }
    } catch (e) { /* 이 종목은 비워 둠 */ }
  }));
  return out;
}

export function mapQuote(q) {
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || null,
    price: num(q.regularMarketPrice),
    change: num(q.regularMarketChange),
    changePct: num(q.regularMarketChangePercent),
    prevClose: num(q.regularMarketPreviousClose),
    open: num(q.regularMarketOpen), high: num(q.regularMarketDayHigh), low: num(q.regularMarketDayLow),
    volume: num(q.regularMarketVolume), avgVolume: num(q.averageDailyVolume3Month),
    marketCap: num(q.marketCap),
    high52: num(q.fiftyTwoWeekHigh), low52: num(q.fiftyTwoWeekLow),
    ma50: num(q.fiftyDayAverage), ma200: num(q.twoHundredDayAverage),
    pe: num(q.trailingPE), forwardPe: num(q.forwardPE),
    currency: q.currency || null, exchange: q.fullExchangeName || q.exchange || null,
    type: q.quoteType || null, marketState: q.marketState || null,
    time: num(q.regularMarketTime)
  };
}

async function fetchQuotes(symbols, retry = true) {
  const { crumb, cookie } = await getCrumb(!retry);
  const resp = await fetch(`${YAHOO}/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(crumb)}`, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if ((resp.status === 401 || resp.status === 403) && retry) { crumbCache = null; return fetchQuotes(symbols, false); }
  if (!resp.ok) throw new Error(`yahoo quote ${resp.status}`);
  const data = await resp.json();
  return ((data && data.quoteResponse && data.quoteResponse.result) || []).map(mapQuote);
}

function parseSymbols(url, max) {
  const list = (url.searchParams.get('symbols') || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const uniq = [...new Set(list)];
  if (!uniq.length || uniq.length > max || !uniq.every(x => SYMBOL_RE.test(x))) return null;
  return uniq;
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

// ---- 야후 금융 달력 (실적·경제지표·IPO·액면분할) ----
// Yahoo 달력 화면이 쓰는 v1/finance/visualization (POST + crumb) 를 대신 호출해 정리된 JSON 으로 돌려준다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ECON_COUNTRIES = ['US', 'KR', 'JP', 'CN', 'DE', 'GB', 'EU'];
const US_TICKER_RE = /^[A-Z]{1,5}([.-][A-Z])?$/;
const IPO_NOISE_RE = /\bwarrants?\b|\brights?\b|\bunits?\b|\bnotes?\b|\bpreferred\b|\bdepositary shares\b|\bfunds?\b|\betf\b|\btrust\b|\bdimensions\b|%/i; // 워런트·권리·유닛·채권·펀드류
const NON_COMMON_RE = /-(P[A-Z]?|W[A-Z]?|U|R)$/; // 우선주·워런트·유닛·권리

async function yahooVisual(body, retry = true) {
  const { crumb, cookie } = await getCrumb(!retry);
  const resp = await fetch(`${YAHOO}/v1/finance/visualization?crumb=${encodeURIComponent(crumb)}&lang=en-US&region=US`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if ((resp.status === 401 || resp.status === 403) && retry) { crumbCache = null; return yahooVisual(body, false); }
  if (!resp.ok) throw new Error(`yahoo calendar ${resp.status}`);
  const data = await resp.json();
  const res = data && data.finance && data.finance.result && data.finance.result[0];
  const doc = res && res.documents && res.documents[0];
  if (!doc) throw new Error('yahoo calendar empty');
  const ids = (doc.columns || []).map(c => c.id);
  return { total: res.total || 0, rows: (doc.rows || []).map(r => Object.fromEntries(ids.map((id, i) => [id, r[i]]))) };
}

async function fetchCalendar(type, from, to) {
  const query = extra => ({
    operator: 'and',
    operands: [
      { operator: 'gte', operands: ['startdatetime', from] },
      { operator: 'lt', operands: ['startdatetime', to] },
      ...extra
    ]
  });
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  if (type === 'earnings') {
    const { rows } = await yahooVisual({
      sortType: 'DESC', entityIdType: 'earnings', sortField: 'intradaymarketcap',
      includeFields: ['ticker', 'companyshortname', 'eventname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct', 'intradaymarketcap'],
      query: query([{ operator: 'eq', operands: ['region', 'us'] }]), offset: 0, size: 250
    });
    return rows.filter(r => r.ticker && !NON_COMMON_RE.test(r.ticker)).slice(0, 200).map(r => ({
      sym: r.ticker, name: r.companyshortname || r.ticker, event: r.eventname || '', ts: r.startdatetime, tt: r.startdatetimetype || '',
      epsEst: n(r.epsestimate), epsAct: n(r.epsactual), surp: n(r.epssurprisepct), mcap: n(r.intradaymarketcap)
    }));
  }

  if (type === 'economic') {
    const country = { operator: 'or', operands: ECON_COUNTRIES.map(c => ({ operator: 'eq', operands: ['country_code', c] })) };
    const out = [];
    for (let offset = 0; offset < 750; offset += 250) { // 한 번에 최대 250건 → 페이지 반복
      const { total, rows } = await yahooVisual({
        sortType: 'ASC', entityIdType: 'economic_event', sortField: 'startdatetime',
        includeFields: ['econ_release', 'country_code', 'period', 'after_release_actual', 'consensus_estimate', 'prior_release_actual', 'startdatetime'],
        query: query([country]), offset, size: 250
      });
      rows.forEach(r => out.push({ name: r.econ_release || '', cc: r.country_code, period: r.period || '', act: r.after_release_actual, est: r.consensus_estimate, prior: r.prior_release_actual, ts: r.startdatetime }));
      if (offset + 250 >= total) break;
    }
    return out;
  }

  if (type === 'ipo') {
    const { rows } = await yahooVisual({
      sortType: 'ASC', entityIdType: 'ipo_info', sortField: 'startdatetime',
      includeFields: ['ticker', 'companyshortname', 'exchange_short_name', 'startdatetime', 'pricefrom', 'priceto', 'offerprice', 'currencyname', 'shares', 'dealtype'],
      query: query([]), offset: 0, size: 100
    });
    return rows.filter(r => !IPO_NOISE_RE.test(`${r.companyshortname || ''}`) && !/^[A-Z]{3,4}[WRU]$/.test(r.ticker || '')).map(r => ({ sym: r.ticker || '', name: r.companyshortname || r.ticker || '', exch: r.exchange_short_name || '', ts: r.startdatetime, from: n(r.pricefrom), to: n(r.priceto), offer: n(r.offerprice), cur: r.currencyname || '', shares: n(r.shares), deal: r.dealtype || '' }));
  }

  if (type === 'splits') {
    const { rows } = await yahooVisual({
      sortType: 'ASC', entityIdType: 'splits', sortField: 'startdatetime',
      includeFields: ['ticker', 'companyshortname', 'startdatetime', 'optionable', 'old_share_worth', 'share_worth'],
      query: query([]), offset: 0, size: 250
    });
    return rows.filter(r => r.ticker && US_TICKER_RE.test(r.ticker)).map(r => ({ sym: r.ticker, name: r.companyshortname || r.ticker, ts: r.startdatetime, old: n(r.old_share_worth), new: n(r.share_worth), opt: !!r.optionable }));
  }
  return [];
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

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
      if (q.length < 1) return json({ error: 'invalid query' }, 400, request, env);
      try {
        return await cached(request, ctx, 3600, async () => json({ query: q, results: await searchSymbols(q) }, 200, request, env, 3600));
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/spark' || url.pathname === '/api/quotes') {
      const isSpark = url.pathname === '/api/spark';
      const symbols = parseSymbols(url, isSpark ? 120 : 60);
      if (!symbols) return json({ error: 'invalid symbols' }, 400, request, env);
      try {
        if (isSpark) {
          const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '3mo';
          const interval = INTERVALS.has(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '1d';
          return await cached(request, ctx, 60, async () => json(await fetchSparkAll(symbols, range, interval), 200, request, env, 60));
        }
        return await cached(request, ctx, 30, async () => json({ quotes: await fetchQuotes(symbols) }, 200, request, env, 30));
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/calendar') {
      const type = url.searchParams.get('type') || '';
      const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
      if (!['earnings', 'economic', 'ipo', 'splits'].includes(type) || !DATE_RE.test(from) || !DATE_RE.test(to) || to <= from || (Date.parse(to) - Date.parse(from)) / 86400000 > 70) {
        return json({ error: 'invalid params' }, 400, request, env);
      }
      try {
        return await cached(request, ctx, 1800, async () => json({ type, from, to, items: await fetchCalendar(type, from, to) }, 200, request, env, 1800));
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (url.pathname === '/api/chart' || url.pathname === '/api/fundamentals' || url.pathname === '/api/deep') {
      if (!SYMBOL_RE.test(symbol)) return json({ error: 'invalid symbol' }, 400, request, env);
    }

    try {
      if (url.pathname === '/api/chart') {
        const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1y';
        const interval = INTERVALS.has(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '1d';
        return await cached(request, ctx, 60, async () => {
          const upstream = await fetch(
            `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
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

      if (url.pathname === '/api/deep') {
        return await cached(request, ctx, 3600, async () => {
          const [out, news] = await Promise.all([fetchQuoteSummary(symbol, DEEP_MODULES), fetchNews(symbol)]);
          if (out.notFound) return json({ error: 'not found' }, 404, request, env);
          return json(mapDeep(symbol, out.result, news), 200, request, env, 3600);
        });
      }
    } catch (err) {
      return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
    }

    return json({ error: 'not found' }, 404, request, env);
  }
};
