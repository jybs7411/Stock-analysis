// 전망 엔진 테스트: node tools/test-forecast.mjs
//  index.html 의 <script id="mod-forecast"> 를 꺼내 vm 에서 실행하고(브라우저 없이), 합성 일봉으로 성질을 검사한다.
//   1) 미래 참조 없음: 뒤쪽 봉을 바꿔도 과거 시점의 계산(변동성·유사 국면)은 그대로다.
//   2) 구간 적중률: 변동성이 뭉치는(GARCH) 난수 시계열에서 50%·80% 구간이 명목값 근처로 들어온다.
//   3) 방향: 무작위 걸음에는 예측력이 없다고 나와야 하고(w≈0), 추세가 이어지는 시계열에서는 기준선보다 나아야 한다.
//   4) 분위수 단조·가격 양수·결정론(같은 입력 → 같은 출력)·짧은 입력 처리.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.FORECAST_SRC
  ? fs.readFileSync(process.env.FORECAST_SRC, 'utf8')
  : (/<script id="mod-forecast">([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8')) || [])[1];
if (!src) { console.error('mod-forecast 스크립트를 찾지 못했습니다'); process.exit(1); }
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const FC = sandbox.window.Forecast;
if (!FC) { console.error('window.Forecast 가 없습니다'); process.exit(1); }

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const gauss = r => { let u = 0, v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// kind: 'rw' 무작위 걸음(변동성 뭉침 포함) / 'trend' 국면이 길게 이어지는 시계열(상승장·하락장이 번갈아, 평균 기울기 국면별 ±)
function gen(seed, n, kind) {
  const r = mulberry32(seed), out = []; let p = 100, v = 0.0002, mu = 0, left = 0;
  const d0 = Date.UTC(2015, 0, 1);
  for (let i = 0; i < n; i++) {
    if (kind === 'trend') { if (left-- <= 0) { mu = (r() < 0.5 ? -1 : 1) * 0.0035; left = 150 + Math.floor(r() * 200); } }
    const e = gauss(r) * Math.sqrt(v), ret = mu + e;
    v = 0.000004 + 0.90 * v + 0.08 * e * e;
    const o = p; p = p * Math.exp(ret);
    const hi = Math.max(o, p) * (1 + Math.abs(gauss(r)) * 0.003), lo = Math.min(o, p) * (1 - Math.abs(gauss(r)) * 0.003);
    out.push({ date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), open: o, high: hi, low: lo, close: p, volume: 1e6 });
  }
  return out;
}

let fail = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fail++; console.error('✗ ' + msg); } };

// 1) 미래 참조 없음
{
  const a = gen(11, 1300, 'rw'), b = a.map(x => ({ ...x }));
  for (let i = 1000; i < b.length; i++) { b[i].close *= 1.5; b[i].high *= 1.5; b[i].low *= 1.5; }
  const Da = FC._prep(a), Db = FC._prep(b);
  let same = true;
  for (let i = 0; i < 1000; i++) if (Da.v[i] !== Db.v[i] || JSON.stringify(Da.F[i]) !== JSON.stringify(Db.F[i])) same = false;
  ok(same, '과거 시점의 변동성·특징이 뒤쪽 봉에 따라 달라짐(미래 참조)');
  const xa = FC._analog(Da, 900, 21), xb = FC._analog(Db, 900, 21);
  ok(JSON.stringify(xa) === JSON.stringify(xb), '유사 국면이 미래 봉에 영향을 받음');
  ok(xa.picks.every(j => j + 21 <= 900), '유사 국면 후보의 결과 구간이 평가 시점을 넘어감');
  const fa = FC.run(a.slice(0, 1000)), fb = FC.run(b.slice(0, 1000));
  ok(JSON.stringify(fa) === JSON.stringify(fb), '같은 과거 구간인데 결과가 다름');
}

// 2) 구간 적중률 + 3) 방향 (여러 시드 평균)
{
  const agg = { rw: { c50: [], c80: [], skill: [], w: [] }, trend: { c50: [], c80: [], skill: [], w: [], hit: [], up: [] } };
  for (const kind of ['rw', 'trend']) for (let s = 1; s <= 12; s++) {
    const f = FC.run(gen(s * 97 + (kind === 'rw' ? 0 : 5), 1500, kind));
    ok(f.ok, `${kind}#${s} 실행 실패`);
    for (const h of FC.CFG.horizons) {
      const z = f.horizons[h]; ok(z.ok && z.val, `${kind}#${s} h${h} 검증 없음`);
      if (!z.ok || !z.val) continue;
      const qs = FC.CFG.qs.map(p => z.q[p]);
      ok(qs.every((x, i) => !i || x >= qs[i - 1]), `${kind}#${s} h${h} 분위수가 단조 증가가 아님`);
      ok(FC.CFG.qs.every(p => z.price[p] > 0), `${kind}#${s} h${h} 가격 ≤ 0`);
      ok(z.kappa >= FC.CFG.kappaMin && z.kappa <= FC.CFG.kappaMax, `${kind}#${s} h${h} kappa 범위 벗어남`);
      ok(z.pUp >= 0 && z.pUp <= 1 && z.w >= 0 && z.w <= 1, `${kind}#${s} h${h} 확률·가중 범위 벗어남`);
      if (h === 21) { agg[kind].c50.push(z.val.cover50); agg[kind].c80.push(z.val.cover80); agg[kind].skill.push(z.val.skill); agg[kind].w.push(z.w); if (kind === 'trend') { agg.trend.hit.push(z.val.hit); agg.trend.up.push(z.val.upRate); } }
    }
    ok(f.cone.length === FC.CFG.coneH.length && f.cone.every(c => c.p5 < c.p25 && c.p25 < c.p50 && c.p50 < c.p75 && c.p75 < c.p95), `${kind}#${s} 콘 순서 오류`);
    ok(f.cone[f.cone.length - 1].p95 - f.cone[f.cone.length - 1].p5 > f.cone[0].p95 - f.cone[0].p5, `${kind}#${s} 콘이 기간에 따라 넓어지지 않음`);
    ok(f.regime && /^(up|down|mixed)_(high|mid|low)$/.test(f.regime.id), `${kind}#${s} 국면 id 오류`);
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rw = agg.rw, tr = agg.trend;
  console.log(`무작위 걸음  : 50% 구간 적중 ${mean(rw.c50).toFixed(1)}% · 80% 구간 ${mean(rw.c80).toFixed(1)}% · 방향 스킬 ${mean(rw.skill).toFixed(3)} · w ${mean(rw.w).toFixed(2)}`);
  console.log(`추세 지속형  : 50% 구간 적중 ${mean(tr.c50).toFixed(1)}% · 80% 구간 ${mean(tr.c80).toFixed(1)}% · 방향 스킬 ${mean(tr.skill).toFixed(3)} · w ${mean(tr.w).toFixed(2)} · 방향 적중 ${mean(tr.hit).toFixed(1)}%`);
  ok(Math.abs(mean(rw.c50) - 50) <= 7, '무작위 걸음: 50% 구간 적중률이 명목값에서 7%p 넘게 벗어남');
  ok(Math.abs(mean(rw.c80) - 80) <= 7, '무작위 걸음: 80% 구간 적중률이 명목값에서 7%p 넘게 벗어남');
  ok(mean(rw.skill) < 0.02, '무작위 걸음인데 방향 예측력이 있다고 나옴');
  ok(mean(rw.w) < 0.25, '무작위 걸음인데 유사 국면 가중이 큼');
  ok(mean(tr.skill) > 0.03, '추세 지속형인데 방향 스킬이 기준선보다 낫지 않음');
  ok(mean(tr.hit) > 58, '추세 지속형인데 방향 적중률이 낮음');
  ok(mean(tr.w) > mean(rw.w), '추세 지속형의 가중이 무작위 걸음보다 크지 않음');
}

// 4) 결정론 · 짧은 입력 · 불량 입력 · 채점
{
  const h = gen(5, 900, 'rw');
  ok(JSON.stringify(FC.run(h)) === JSON.stringify(FC.run(h)), '같은 입력인데 결과가 다름');
  ok(FC.run(h.slice(0, 80)).ok === false, '일봉이 부족한데 ok');
  ok(FC.run(null).ok === false && FC.run([]).ok === false, '빈 입력 처리');
  const dirty = h.slice(); dirty[300] = { close: NaN }; dirty[301] = null; dirty[302] = { close: -3 };
  ok(FC.run(dirty).ok === true, '불량 봉이 섞이면 실패함');
  const short = FC.run(h.slice(0, 330));
  ok(short.ok && short.horizons[5].ok && short.horizons[5].analog === null, '검증 표본이 없는 짧은 이력: 구간만 나와야 함');
  ok(FC.run(h, { noDrift: true }).horizons[21].center !== FC.run(h).horizons[21].center, 'noDrift 옵션이 반영되지 않음');
  ok(FC.scoreCall(0.5, true).points === 75 && FC.scoreCall(1, true).points === 100 && FC.scoreCall(1, false).points === 0 && FC.scoreCall(NaN, true) === null, '채점 함수');
  ok(Object.isFrozen(FC.CFG), 'CFG 가 고정되어 있지 않음');
}

console.log(`${checks - fail}/${checks} 통과`);
process.exit(fail ? 1 : 0);
