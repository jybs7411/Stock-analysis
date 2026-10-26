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
 *   GET /api/revisions?symbol=NVDA               -> EPS 추정치 변화(7/30/60/90일 전)·상향/하향 건수·최근 서프라이즈·업종 (리비전 랭크용)
 *   GET /api/deep?symbol=NVDA                    -> 실적·재무·애널리스트·수급·배당·뉴스 (심층 분석용)
 *   GET /api/calendar?type=earnings|economic|ipo|splits&from=YYYY-MM-DD&to=YYYY-MM-DD -> 야후 금융 달력 {type,from,to,items[]} (기간 최대 70일)
 *   GET /api/fred?ids=DGS10,DGS2,T10Y2Y,BAMLH0A0HYM2 -> (키 불필요) FRED 공식 금리·스프레드 시리즈 {series:{ID:{last,prev,d1,d5,d21,pct1y,t,v}}}
 *   GET /api/feargreed                           -> (키 불필요) CNN 공포·탐욕 지수 (비공식)
 *   GET /api/finnhub?kind=reco|insider|peers|surprise&symbol=AAPL, ?kind=news -> (FINNHUB_KEY 필요) 추천 추이 / 내부자 심리 / 동종 종목 / EPS 서프라이즈 / 시장 헤드라인
 *   야후 장애 시 /api/chart·/api/spark 는 Stooq, /api/quotes 는 Finnhub→Stooq, /api/calendar(실적·IPO)는 Finnhub 로 자동 대체 (X-Source 헤더)
 *
 * 응답 헤더: X-Fetched-At(데이터를 받아 온 시각, ISO) · X-Cache(HIT|MISS|STALE — STALE 이면 야후 장애로 마지막 성공본을 돌려준 것)
 *
 * 환경 변수 (wrangler.toml [vars] 또는 대시보드)
 *   ALLOWED_ORIGIN  허용할 Origin (예: https://jybs7411.github.io). 비우면 "*" 허용.
 *   FRED_KEY        (선택, Secret) FRED 공식 API 키. 없으면 공개 CSV 사용.
 *   FINNHUB_KEY     (선택, Secret) Finnhub 무료 키. 없으면 Finnhub 보강만 건너뜀.
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
    // 프런트가 '데이터 기준 시각·캐시 상태'를 표시할 수 있게 노출
    'Access-Control-Expose-Headers': 'X-Fetched-At, X-Cache, X-Source',
    'Vary': 'Origin'
  };
}

function json(body, status, request, env, cacheSeconds = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Fetched-At': new Date().toISOString(),
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
    shortRatio: num(stats.shortRatio),
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


// ---- EPS 추정치 리비전 (리비전 랭크용) ----
const REV_MODULES = 'earningsTrend,earningsHistory,assetProfile,price';
export function mapRevisions(symbol, r) {
  const trend = (r.earningsTrend && r.earningsTrend.trend) || [];
  const pick = period => {
    const x = trend.find(t => t.period === period);
    if (!x || !x.epsTrend) return null;
    const e = x.epsTrend, rv = x.epsRevisions || {};
    return {
      cur: num(e.current), d7: num(e['7daysAgo']), d30: num(e['30daysAgo']), d60: num(e['60daysAgo']), d90: num(e['90daysAgo']),
      up7: num(rv.upLast7days), up30: num(rv.upLast30days), down7: num(rv.downLast7Days), down30: num(rv.downLast30days)
    };
  };
  const hist = ((r.earningsHistory && r.earningsHistory.history) || []).map(h => pct(h.surprisePercent)).filter(v => v !== null);
  const prof = r.assetProfile || {}, pr = r.price || {};
  return {
    symbol,
    name: pr.shortName || pr.longName || null,
    sector: prof.sector || null,
    industry: prof.industry || null,
    fy0: pick('0y'), fy1: pick('+1y'), q0: pick('0q'),
    surprises: hist.slice(-4)
  };
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
  // 그래도 없는 종목은 Stooq 일봉으로 보충 (일/주/월봉만, 최대 15개 — 서브요청 한도 고려)
  if (DAILY_IV[interval]) {
    const still = symbols.filter(s => !out[s] && stooqSymbol(s)).slice(0, 15);
    await Promise.all(still.map(async sym => {
      try {
        const rows = await stooqRows(sym, interval, range);
        if (rows) out[sym] = { t: rows.map(r => r.t), c: rows.map(r => r.c), prev: rows.length > 1 ? rows[rows.length - 2].c : null, price: rows[rows.length - 1].c, currency: 'USD' };
      } catch (e) { /* 이 종목은 비워 둠 */ }
    }));
  }
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

// 신선 캐시(ttl) + 장애 대비 stale 캐시(STALE_TTL). 야후가 실패(예외·5xx)하면 마지막으로 성공한 응답을 X-Cache: STALE 로 돌려준다.
const STALE_TTL = 24 * 3600;
const staleKey = request => new Request(request.url + (request.url.includes('?') ? '&' : '?') + '__stale=1');

async function cached(request, ctx, ttl, producer) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const withStale = async err => {
    const old = cache ? await cache.match(staleKey(request)) : null;
    if (!old) { if (err) throw err; return null; }
    const headers = new Headers(old.headers);
    headers.set('X-Cache', 'STALE');
    headers.set('Cache-Control', 'no-store');
    return new Response(old.body, { status: 200, headers });
  };
  let res;
  try { res = await producer(); } catch (err) { return withStale(err); }
  if (res.status >= 500) return (await withStale(null)) || res;
  if (cache && res.ok) {
    const put = (key, maxAge) => {
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', `public, max-age=${maxAge}`);
      const p = cache.put(key, new Response(res.clone().body, { status: res.status, headers }));
      return ctx && ctx.waitUntil ? (ctx.waitUntil(p), null) : p;
    };
    await put(request, ttl);
    await put(staleKey(request), STALE_TTL);
    const headers = new Headers(res.headers);
    headers.set('X-Cache', 'MISS');
    return new Response(res.body, { status: res.status, headers });
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

// ---- 보조 데이터 소스 (야후 장애·보완용) ----
// 키 없이: Stooq(일봉 백업) · FRED CSV(공식 금리·신용 스프레드) · CNN Fear & Greed(비공식)
// 키 있으면: Finnhub (환경 변수 FINNHUB_KEY — 시세 백업 · 애널리스트 추천 · 내부자 심리 · 실적/IPO 캘린더 백업)
// 모두 실패해도 야후 경로는 영향받지 않으며, 응답에 X-Source 헤더(stooq|finnhub)가 붙는다.
const STOOQ = 'https://stooq.com';
const STOOQ_INDEX = { '^GSPC': '^spx', '^DJI': '^dji', '^IXIC': '^ndq', '^NDX': '^ndx' };
const RANGE_DAYS = { '1d': 7, '5d': 10, '1mo': 31, '3mo': 93, '6mo': 186, '1y': 366, '2y': 731, '5y': 1830, '10y': 3660, ytd: 366, max: 1e9 };
const DAILY_IV = { '1d': 'd', '1wk': 'w', '1mo': 'm' };
const SRC_UA = { 'User-Agent': UA, 'Accept': '*/*' };

function stooqSymbol(sym) {
  if (STOOQ_INDEX[sym]) return STOOQ_INDEX[sym];
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(sym)) return sym.toLowerCase() + '.us';
  return null; // 선물·환율·VIX 등은 Stooq 심볼로 안전하게 바꿀 수 없어 건너뜀
}

export function parseStooqCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open,high,low,close/i.test(lines[0])) return null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const t = Date.parse(f[0] + 'T21:00:00Z') / 1000, o = +f[1], h = +f[2], l = +f[3], c = +f[4], v = +f[5];
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    rows.push({ t, o: Number.isFinite(o) ? o : c, h: Number.isFinite(h) ? h : c, l: Number.isFinite(l) ? l : c, c, v: Number.isFinite(v) ? v : 0 });
  }
  return rows.length ? rows : null;
}

async function stooqRows(sym, interval, range) {
  const code = stooqSymbol(sym), ivc = DAILY_IV[interval];
  if (!code || !ivc) return null;
  const resp = await fetch(`${STOOQ}/q/d/l/?s=${encodeURIComponent(code)}&i=${ivc}`, { headers: SRC_UA });
  if (!resp.ok) return null;
  let rows = parseStooqCsv(await resp.text());
  if (!rows) return null;
  const days = range === 'ytd' ? Math.max(1, (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400000 + 5) : (RANGE_DAYS[range] || 366);
  const cut = Date.now() / 1000 - days * 86400;
  const sliced = rows.filter(r => r.t >= cut);
  return sliced.length >= 2 ? sliced : rows.slice(-2);
}

// Stooq 일봉 → Yahoo v8 chart 호환 JSON (프런트 parseYahooChart 가 그대로 읽는다)
export function stooqToChart(sym, rows, interval) {
  const last = rows[rows.length - 1], prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return { chart: { result: [{
    meta: { symbol: sym, currency: 'USD', exchangeName: 'Stooq', dataGranularity: interval, regularMarketPrice: last.c, chartPreviousClose: prev ? prev.c : null, previousClose: prev ? prev.c : null, regularMarketTime: last.t, source: 'stooq' },
    timestamp: rows.map(r => r.t),
    indicators: { quote: [{ open: rows.map(r => r.o), high: rows.map(r => r.h), low: rows.map(r => r.l), close: rows.map(r => r.c), volume: rows.map(r => r.v) }] }
  }], error: null } };
}

async function stooqChart(sym, range, interval) {
  const rows = await stooqRows(sym, interval, range);
  return rows ? stooqToChart(sym, rows, interval) : null;
}

// Finnhub (키 있을 때만)
async function finnhub(env, path, params) {
  if (!env || !env.FINNHUB_KEY) return null;
  const qs = new URLSearchParams({ ...params, token: env.FINNHUB_KEY });
  const resp = await fetch(`https://finnhub.io/api/v1/${path}?${qs}`, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`finnhub ${path} ${resp.status}`);
  return resp.json();
}

// 야후 시세 실패 시 대체: Finnhub quote(키 있으면) → Stooq 최근 2개 일봉. 시총·52주 등은 비워 둠.
async function fetchQuotesFallback(symbols, env) {
  const out = [];
  await Promise.all(symbols.slice(0, 20).map(async sym => {
    try {
      const fh = await finnhub(env, 'quote', { symbol: sym });
      if (fh && num(fh.c) && num(fh.c) > 0) {
        out.push({ symbol: sym, name: null, price: num(fh.c), change: num(fh.d), changePct: num(fh.dp), prevClose: num(fh.pc), open: num(fh.o), high: num(fh.h), low: num(fh.l), volume: null, avgVolume: null, marketCap: null, high52: null, low52: null, ma50: null, ma200: null, pe: null, forwardPe: null, currency: 'USD', exchange: null, type: null, marketState: null, time: num(fh.t) });
        return;
      }
    } catch (e) { /* Stooq 로 */ }
    try {
      const rows = await stooqRows(sym, '1d', '5d');
      if (rows && rows.length >= 2) {
        const a = rows[rows.length - 1], b = rows[rows.length - 2];
        out.push({ symbol: sym, name: null, price: a.c, change: a.c - b.c, changePct: (a.c / b.c - 1) * 100, prevClose: b.c, open: a.o, high: a.h, low: a.l, volume: a.v, avgVolume: null, marketCap: null, high52: null, low52: null, ma50: null, ma200: null, pe: null, forwardPe: null, currency: 'USD', exchange: null, type: null, marketState: null, time: a.t });
      }
    } catch (e) { /* 이 종목은 비워 둠 */ }
  }));
  return out;
}

// FRED — 키 없이 읽을 수 있는 공개 CSV (fredgraph.csv). 허용 시리즈만 중계한다.
const FRED_IDS = {
  DGS10: '미 10년물 국채금리(%)', DGS2: '미 2년물 국채금리(%)', DGS3MO: '미 3개월 국채금리(%)',
  T10Y2Y: '장단기 금리차 10Y-2Y(%p)', T10Y3M: '장단기 금리차 10Y-3M(%p)',
  BAMLH0A0HYM2: '하이일드 스프레드(OAS, %p)', BAMLC0A0CM: '투자등급 회사채 스프레드(OAS, %p)',
  DFII10: '10년 실질금리(%)', T10YIE: '10년 기대인플레이션(%)', VIXCLS: 'VIX 종가',
  DFF: '연방기금금리 실효(%)', UNRATE: '실업률(%)', CPIAUCSL: '소비자물가지수(CPI, 지수)', PCEPILFE: '근원 PCE 물가지수(지수)',
  ICSA: '신규 실업수당 청구(건, 주간)', STLFSI4: '금융 스트레스 지수(0=평균, 주간)', DTWEXBGS: '달러 광의 지수(일간)'
};
export function parseFredCsv(text, id) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^(date|observation_date)\s*,/i.test(lines[0])) return null;
  const t = [], v = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const x = f[1] === undefined || f[1] === '' || f[1] === '.' ? NaN : +f[1];
    if (!Number.isFinite(x) || !/^\d{4}-\d{2}-\d{2}$/.test(f[0])) continue;
    t.push(f[0]); v.push(x);
  }
  return fredStats(id, t, v);
}
function fredStats(id, t, v) {
  if (!v.length) return null;
  const n = v.length, last = v[n - 1], at = k => (n > k ? v[n - 1 - k] : null);
  const win = v.slice(-252), below = win.filter(x => x <= last).length;
  return { id, label: FRED_IDS[id] || id, date: t[n - 1], last, prev: at(1), d1: n > 1 ? last - v[n - 2] : null, d5: at(5) !== null ? last - at(5) : null, d21: at(21) !== null ? last - at(21) : null,
    pct1y: win.length >= 60 ? below / win.length * 100 : null, t: t.slice(-120), v: v.slice(-120) };
}
// 공식 API(FRED_KEY 있을 때) 응답 → 같은 통계 형식
export function parseFredObs(j, id) {
  const t = [], v = [];
  ((j && j.observations) || []).forEach(o => {
    const x = o.value === '.' || o.value === '' || o.value == null ? NaN : +o.value;
    if (Number.isFinite(x) && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) { t.push(o.date); v.push(x); }
  });
  return fredStats(id, t, v);
}
async function fetchFred(ids, env) {
  const cosd = new Date(Date.now() - 470 * 86400000).toISOString().slice(0, 10);
  const out = {};
  await Promise.all(ids.map(async id => {
    if (env && env.FRED_KEY) { // 공식 API 우선, 실패하면 아래 공개 CSV 로
      try {
        const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(env.FRED_KEY)}&file_type=json&observation_start=${cosd}`, { headers: SRC_UA });
        if (r.ok) { const m = parseFredObs(await r.json(), id); if (m) { out[id] = m; return; } }
      } catch (e) { /* CSV 로 */ }
    }
    try {
      const resp = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, { headers: SRC_UA });
      if (!resp.ok) return;
      const m = parseFredCsv(await resp.text(), id);
      if (m) out[id] = m;
    } catch (e) { /* 이 시리즈만 생략 */ }
  }));
  return out;
}

// CNN Fear & Greed — 비공식 엔드포인트라 형식이 바뀌거나 막힐 수 있다(실패하면 502).
export function mapFearGreed(j) {
  const fg = j && j.fear_and_greed;
  if (!fg || !Number.isFinite(+fg.score)) return null;
  const hist = ((j.fear_and_greed_historical && j.fear_and_greed_historical.data) || []).slice(-30).map(p => ({ t: p.x, v: Math.round(p.y * 10) / 10 })).filter(p => Number.isFinite(p.v));
  return { score: Math.round(+fg.score * 10) / 10, rating: fg.rating || null, prevClose: num(fg.previous_close), week: num(fg.previous_1_week), month: num(fg.previous_1_month), year: num(fg.previous_1_year), timestamp: fg.timestamp || null, history: hist };
}
// Kalshi 공개 예측시장(키 불필요) — 매크로 관련 시리즈의 가장 가까운 이벤트만 추려 확률(0~1)로 반환
const PREDICT_SERIES = [
  { id: 'KXFEDDECISION', ko: '연준 금리 결정' },
  { id: 'KXRECSSNBER', ko: '미국 경기침체' },
  { id: 'KXCPI', ko: '미국 CPI(전월비)' }
];
async function fetchPredict() {
  const out = [];
  await Promise.all(PREDICT_SERIES.map(async (sr) => {
    try {
      const r = await fetch(`https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${sr.id}&status=open&limit=100`, { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const ms = (d.markets || []).filter(m => m.close_time);
      if (!ms.length) return;
      const first = ms.map(m => m.close_time).sort()[0];
      const ev = ms.find(m => m.close_time === first).event_ticker;
      const items = ms.filter(m => m.event_ticker === ev).map(m => {
        const bid = parseFloat(m.yes_bid_dollars), ask = parseFloat(m.yes_ask_dollars), last = parseFloat(m.last_price_dollars);
        const p = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (isFinite(last) && last > 0 ? last : null);
        return { label: m.yes_sub_title || m.title, p, vol: parseFloat(m.volume_24h_fp) || 0, url: 'https://kalshi.com/markets/' + sr.id.toLowerCase() };
      }).filter(x => x.p != null);
      if (items.length) out.push({ id: sr.id, ko: sr.ko, title: ms.find(m => m.event_ticker === ev).title, close: first, items });
    } catch (e) { /* 한 시리즈 실패는 건너뜀 */ }
  }));
  out.sort((a, b) => PREDICT_SERIES.findIndex(x => x.id === a.id) - PREDICT_SERIES.findIndex(x => x.id === b.id));
  return { source: 'Kalshi', fetchedAt: Date.now(), groups: out };
}

async function fetchFearGreed() {
  const resp = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graph/data', { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://edition.cnn.com', Referer: 'https://edition.cnn.com/' } });
  if (!resp.ok) throw new Error(`cnn ${resp.status}`);
  const m = mapFearGreed(await resp.json());
  if (!m) throw new Error('cnn format');
  return m;
}

// Finnhub 시장 뉴스 → 헤드라인 (링크는 http(s) 만 허용)
export function mapFinnhubNews(arr) {
  return (Array.isArray(arr) ? arr : []).filter(a => a && a.headline && /^https?:\/\//i.test(a.url || '')).slice(0, 12).map(a => ({
    headline: String(a.headline).slice(0, 200), source: String(a.source || '').slice(0, 40), time: num(a.datetime), url: a.url, summary: String(a.summary || '').slice(0, 240) }));
}

// Finnhub 캘린더 → 야후 캘린더와 같은 항목 형식 (실적·IPO 만)
export function mapFinnhubCalendar(type, j) {
  const ts = d => (d ? new Date(d + 'T13:00:00Z').toISOString() : null);
  if (type === 'earnings') {
    return ((j && j.earningsCalendar) || []).filter(r => r.symbol && !NON_COMMON_RE.test(r.symbol)).slice(0, 200).map(r => ({
      sym: r.symbol, name: r.symbol, event: '', ts: ts(r.date), tt: ({ bmo: 'BMO', amc: 'AMC', dmh: 'TNS' })[r.hour] || '',
      epsEst: num(r.epsEstimate), epsAct: num(r.epsActual), surp: (num(r.epsEstimate) && num(r.epsActual) !== null) ? (r.epsActual / r.epsEstimate - 1) * 100 : null, mcap: null }));
  }
  if (type === 'ipo') {
    return ((j && j.ipoCalendar) || []).map(r => ({ sym: r.symbol || '', name: r.name || r.symbol || '', exch: r.exchange || '', ts: ts(r.date), from: null, to: null, offer: num(r.price), cur: 'USD', shares: num(r.numberOfShares), deal: r.status || '' }));
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
      return json({ ok: true, service: 'pentanalyst-proxy', sources: { yahoo: true, stooq: true, fred: true, feargreed: true, predict: true, fredKey: !!(env && env.FRED_KEY), finnhub: !!(env && env.FINNHUB_KEY) } }, 200, request, env);
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
          return await cached(request, ctx, 60, async () => {
            const data = await fetchSparkAll(symbols, range, interval);
            if (!Object.keys(data).length) throw new Error('yahoo spark empty'); // 전부 실패 → stale 캐시 또는 502
            return json(data, 200, request, env, 60);
          });
        }
        return await cached(request, ctx, 30, async () => {
          try {
            const quotes = await fetchQuotes(symbols);
            if (quotes.length) return json({ quotes }, 200, request, env, 30);
            throw new Error('yahoo quotes empty');
          } catch (err) {
            const quotes = await fetchQuotesFallback(symbols, env); // Finnhub → Stooq
            if (!quotes.length) throw err;
            const res = json({ quotes, degraded: true }, 200, request, env, 30);
            res.headers.set('X-Source', (env && env.FINNHUB_KEY) ? 'finnhub' : 'stooq');
            return res;
          }
        });
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
        return await cached(request, ctx, 1800, async () => {
          try {
            return json({ type, from, to, items: await fetchCalendar(type, from, to) }, 200, request, env, 1800);
          } catch (err) {
            // 야후 실패 시 Finnhub 로 실적·IPO 만 대체 (키 있을 때)
            const path = type === 'earnings' ? 'calendar/earnings' : type === 'ipo' ? 'calendar/ipo' : null;
            const fh = path ? await finnhub(env, path, { from, to }).catch(() => null) : null;
            if (!fh) throw err;
            const res = json({ type, from, to, items: mapFinnhubCalendar(type, fh), degraded: true }, 200, request, env, 600);
            res.headers.set('X-Source', 'finnhub');
            return res;
          }
        });
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/fred') {
      const ids = [...new Set((url.searchParams.get('ids') || 'DGS10,DGS2,DGS3MO,T10Y2Y,BAMLH0A0HYM2').split(',').map(x => x.trim().toUpperCase()))].filter(x => FRED_IDS[x]);
      if (!ids.length || ids.length > 16) return json({ error: 'invalid ids' }, 400, request, env);
      try {
        return await cached(request, ctx, 3600, async () => {
          const series = await fetchFred(ids, env);
          if (!Object.keys(series).length) throw new Error('fred empty');
          return json({ series }, 200, request, env, 3600);
        });
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/predict') {
      try {
        return await cached(request, ctx, 900, async () => json(await fetchPredict(), 200, request, env, 900));
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/feargreed') {
      try {
        return await cached(request, ctx, 1800, async () => json(await fetchFearGreed(), 200, request, env, 1800));
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    if (url.pathname === '/api/finnhub') {
      if (!env || !env.FINNHUB_KEY) return json({ error: 'finnhub key not configured' }, 501, request, env);
      const kind = url.searchParams.get('kind') || '';
      const sym = (url.searchParams.get('symbol') || '').trim().toUpperCase();
      if (kind === 'news') { // 시장 전체 헤드라인 (종목 불필요)
        try {
          return await cached(request, ctx, 900, async () => {
            const arr = await finnhub(env, 'news', { category: 'general' });
            return json({ items: mapFinnhubNews(arr) }, 200, request, env, 900);
          });
        } catch (err) {
          return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
        }
      }
      if (!['reco', 'insider', 'peers', 'surprise'].includes(kind) || !SYMBOL_RE.test(sym)) return json({ error: 'invalid params' }, 400, request, env);
      try {
        return await cached(request, ctx, 6 * 3600, async () => {
          if (kind === 'peers') {
            const arr = await finnhub(env, 'stock/peers', { symbol: sym });
            return json({ symbol: sym, peers: (Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string' && SYMBOL_RE.test(x) && x !== sym).slice(0, 10) }, 200, request, env, 6 * 3600);
          }
          if (kind === 'surprise') {
            const arr = await finnhub(env, 'stock/earnings', { symbol: sym, limit: 4 });
            return json({ symbol: sym, items: (Array.isArray(arr) ? arr : []).slice(0, 4).map(r => ({ period: r.period, actual: num(r.actual), estimate: num(r.estimate), surprisePct: num(r.surprisePercent) })) }, 200, request, env, 6 * 3600);
          }
          if (kind === 'reco') {
            const arr = await finnhub(env, 'stock/recommendation', { symbol: sym });
            return json({ symbol: sym, trend: (Array.isArray(arr) ? arr : []).slice(0, 4).map(r => ({ period: r.period, strongBuy: num(r.strongBuy), buy: num(r.buy), hold: num(r.hold), sell: num(r.sell), strongSell: num(r.strongSell) })) }, 200, request, env, 6 * 3600);
          }
          const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
          const j = await finnhub(env, 'stock/insider-sentiment', { symbol: sym, from, to });
          return json({ symbol: sym, months: ((j && j.data) || []).slice(-12).map(r => ({ year: r.year, month: r.month, change: num(r.change), mspr: num(r.mspr) })) }, 200, request, env, 6 * 3600);
        });
      } catch (err) {
        return json({ error: 'upstream failure', detail: String(err && err.message || err) }, 502, request, env);
      }
    }

    const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
    if (url.pathname === '/api/chart' || url.pathname === '/api/fundamentals' || url.pathname === '/api/deep' || url.pathname === '/api/revisions') {
      if (!SYMBOL_RE.test(symbol)) return json({ error: 'invalid symbol' }, 400, request, env);
    }

    try {
      if (url.pathname === '/api/chart') {
        const range = RANGES.has(url.searchParams.get('range')) ? url.searchParams.get('range') : '1y';
        const interval = INTERVALS.has(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '1d';
        return await cached(request, ctx, 60, async () => {
          // 야후가 실패(네트워크·4xx·5xx)하면 일/주/월봉에 한해 Stooq 로 대체한다
          const fallback = async () => {
            const data = DAILY_IV[interval] ? await stooqChart(symbol, range, interval).catch(() => null) : null;
            if (!data) return null;
            const res = json(data, 200, request, env, 60);
            res.headers.set('X-Source', 'stooq');
            return res;
          };
          const upstream = await fetch(
            `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
            { headers: { 'User-Agent': UA } }
          ).catch(() => null);
          if (!upstream || !upstream.ok) {
            const fb = await fallback();
            if (fb) return fb;
            if (upstream && upstream.status === 404) return json({ error: 'not found' }, 404, request, env);
            return json({ error: `upstream ${upstream ? upstream.status : 'unreachable'}` }, 502, request, env);
          }
          const data = await upstream.json();
          if (data?.chart?.error?.code === 'Not Found' || !data?.chart?.result) {
            return (await fallback()) || json({ error: 'not found' }, 404, request, env);
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

      if (url.pathname === '/api/revisions') {
        return await cached(request, ctx, 6 * 3600, async () => {
          const out = await fetchQuoteSummary(symbol, REV_MODULES);
          if (out.notFound) return json({ error: 'not found' }, 404, request, env);
          return json(mapRevisions(symbol, out.result), 200, request, env, 6 * 3600);
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
