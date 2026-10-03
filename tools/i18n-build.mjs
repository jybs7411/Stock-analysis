// i18n/ko_keys.json + i18n/<lang>.json(번역 맵) → i18n/<lang>.js (앱이 읽는 사전)
// 번역 맵 형식: { "한국어 문구": "translation", ... }  (자리표시자 {0},{1}… 은 그대로 유지)
// 사용: node i18n-build.mjs   → 검증 결과와 누락 수를 출력한다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'i18n');
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'ko_keys.json'), 'utf8'));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phs = s => (s.match(/\{\d+\}/g) || []).sort().join(',');
let bad = 0;
for (const lang of ['en', 'de']) {
  const f = path.join(dir, `${lang}.json`);
  if (!fs.existsSync(f)) { console.log(`${lang}: 번역 파일 없음 (건너뜀)`); continue; }
  const map = JSON.parse(fs.readFileSync(f, 'utf8'));
  const exact = {}, pat = [];
  let missing = 0, mismatch = 0, hangul = 0, empty = 0;
  const issues = [];
  for (const k of keys) {
    const t = map[k.ko];
    if (t === undefined || t === null) { missing++; continue; }
    if (typeof t !== 'string' || !t.trim()) { empty++; continue; }
    if (phs(k.ko) !== phs(t)) { mismatch++; issues.push(['placeholder', k.ko, t]); continue; }
    if (/[가-힣]/.test(t)) { hangul++; issues.push(['hangul', k.ko, t]); }
    if (k.ph === 0) exact[k.ko] = t;
    else {
      const parts = k.ko.split(/\{\d+\}/);
      const lit = parts.reduce((a, b) => a + b.length, 0);
      const hint = parts.slice().sort((a, b) => b.length - a.length)[0];
      if (!hint) continue;
      pat.push([lit, ['^' + parts.map(esc).join('(.*?)') + '$', t, hint]]);
    }
  }
  pat.sort((a, b) => b[0] - a[0]);
  const out = `window.__I18N=${JSON.stringify({ exact, pat: pat.map(p => p[1]) })};\n`;
  fs.writeFileSync(path.join(dir, `${lang}.js`), out);
  console.log(`${lang}: exact ${Object.keys(exact).length}, pattern ${pat.length}, 누락 ${missing}, 빈값 ${empty}, 자리표시자 불일치 ${mismatch}, 한글 잔존 ${hangul}, 파일 ${(out.length / 1024).toFixed(0)}KB`);
  if (issues.length) fs.writeFileSync(path.join(dir, `${lang}.issues.json`), JSON.stringify(issues, null, 1));
  bad += missing + mismatch + empty;
}
process.exitCode = 0;
