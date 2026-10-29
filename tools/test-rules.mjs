// 규칙 엔진 테스트: node tools/test-rules.mjs
//  1) index.html 의 <script id="mod-rules"> 를 꺼내 vm 에서 실행한다 (브라우저 없이).
//  2) tools/rules-golden.json (기존 Python 규칙의 결과, tools/gen-rules-golden.py 가 생성)과 모든 케이스가 같은지 대조한다.
//  3) 몇 가지 경계 동작(실적일 계산, 설정 고정, 입력 결측)을 따로 검사한다.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const m = /<script id="mod-rules">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('mod-rules 스크립트를 찾지 못했습니다'); process.exit(1); }
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox);
const RE = sandbox.window.RuleEngine;
if (!RE) { console.error('window.RuleEngine 이 없습니다'); process.exit(1); }

// gen-rules-golden.py 와 같은 PRNG·일봉 생성기
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function genHist(seed, n, vol, start) {
  const r = mulberry32(seed); let c = start; const out = [];
  for (let i = 0; i < n; i++) {
    const step = Math.floor((r() - 0.5) * 2 * vol);
    c = Math.max(100, c + step);
    const h = c + Math.floor(r() * 80), l = Math.max(50, c - Math.floor(r() * 80));
    out.push({ close: c / 100, high: h / 100, low: l / 100 });
  }
  return out;
}

let fail = 0, checks = 0, exactLv = 0, lvCount = 0;
const bad = (id, what, got, want) => { fail++; if (fail <= 25) console.error(`✗ ${id} ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const eq = (id, what, got, want) => { checks++; if (JSON.stringify(got) !== JSON.stringify(want)) bad(id, what, got, want); };
// 가격대는 ±0.01 허용: Python 3.12+ 의 sum() 은 보정 합산이라 20·50일 평균이 마지막 자리에서 1센트 다를 수 있다 (판정에는 영향 없음)
const near = (id, what, got, want, tol = 0.011) => {
  checks++;
  if (got === null || want === null) { if (got !== want) bad(id, what, got, want); return; }
  if (Math.abs(got - want) > tol) bad(id, what, got, want);
};

const golden = JSON.parse(fs.readFileSync(path.join(here, 'rules-golden.json'), 'utf8'));
for (const c of golden.cases) {
  const id = `case#${c.seed}`, hist = genHist(c.seed, c.n, c.vol, c.start);
  const res = RE.evaluate(c.x, hist, { nextEarnings: c.nextEarnings, today: c.today });
  const e = c.expect;
  eq(id, 'score', res.score, e.score);
  eq(id, 'verdict', res.verdict, e.verdict);
  eq(id, 'reason', res.reason, e.reason);
  eq(id, 'days', res.daysToEarnings, e.days);
  eq(id, 'levels 유무', res.levels !== null, e.levels !== null);
  if (res.levels && e.levels) {
    lvCount++;
    let exact = true;
    for (const k of ['support', 'buy', 'stop', 'sell', 'sma20', 'sma50', 'sma200', 'low20', 'low60', 'high52']) {
      near(id, 'levels.' + k, res.levels[k], e.levels[k]);
      if (res.levels[k] !== e.levels[k]) exact = false;
    }
    if (exact) exactLv++;
  }
  eq(id, 'pbCandidate', RE.isPullbackCandidate(c.x, c.capB), e.pbCandidate);
  eq(id, 'pbAction', RE.pullbackAction(c.x, res.score, res.levels, res.daysToEarnings), e.pbAction);
}


// 판정·눌림목 경계 격자 (점수·RSI·지지선 거리·실적까지 일수)
for (const [i, b] of (golden.verdictCases || []).entries()) {
  const lv = b.support === null ? null : { support: b.support };
  const r = RE.verdict(b.x, b.score, lv, b.days);
  eq(`verdict#${i}`, JSON.stringify(b), `${r.verdict}/${r.reason}`, `${b.verdict}/${b.reason}`);
}
for (const [i, b] of (golden.pullbackCases || []).entries()) {
  const lv = b.support === null ? null : { support: b.support };
  eq(`pullback#${i}`, JSON.stringify(b), RE.pullbackAction(b.x, b.score, lv, b.days), b.action);
}

// 경계 동작
const t = (name, got, want) => eq('unit', name, got, want);
t('daysUntil 같은 날', RE.daysUntil('2026-10-29', '2026-10-29'), 0);
t('daysUntil 연말 넘김', RE.daysUntil('2027-01-05', '2026-12-30'), 6);
t('daysUntil 지난 날', RE.daysUntil('2026-10-27', '2026-10-29'), -2);
t('daysUntil 모름', RE.daysUntil(null, '2026-10-29'), null);
t('CFG 고정', Object.isFrozen(RE.CFG), true);
t('빈 입력 점수 0', RE.score({}).score, 0);
t('가격 없음 → hold/no_data', RE.verdict({}, 9, null, null).reason, 'no_data');
t('일봉 59개면 가격대 없음', RE.levels(genHist(1, 59, 100, 5000), 50, 2), null);
t('NaN 입력 무시', RE.score({ rsi: NaN, sma200Pct: NaN }).score, 0);
t('UNDERPERFORM 은 감점 없음(기존 규칙 유지)', RE.score({ consensus: 'UNDERPERFORM' }).score, 0);
t('STRONG BUY +1', RE.score({ consensus: 'STRONG BUY' }).score, 1);

console.log(`케이스 ${golden.cases.length}개 · 경계격자 ${(golden.verdictCases||[]).length}+${(golden.pullbackCases||[]).length} · 검사 ${checks}건 · 가격대 정확 일치 ${exactLv}/${lvCount} · 실패 ${fail}건`);
process.exit(fail ? 1 : 0);
