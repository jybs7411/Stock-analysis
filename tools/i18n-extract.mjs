// index.html 에서 '화면에 보일 수 있는 한국어 문구'를 추출해 i18n/ko_keys.json 으로 저장한다.
//  - 정적 HTML 의 텍스트 노드·속성(title/placeholder/aria-label/alt/label/value)
//  - <script> 안의 문자열 리터럴·템플릿 리터럴(acorn 으로 파싱; ${…} 는 {0},{1}… 자리표시자로 치환)
//    HTML 이 들어 있는 템플릿은 태그 경계로 잘라 '텍스트 노드 단위' 조각으로 만든다(렌더된 DOM 텍스트와 같은 단위).
// 제외: Gemini 프롬프트(변수·함수·속성 이름에 prompt 포함), NAME_TO_TICKER_MAP 의 키(검색용 데이터)
// 사용: node i18n-extract.mjs   (tools 폴더에서)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const HAN = /[가-힣]/;
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label', 'value'];

const keys = new Map(); // ko(normalized) → { ph, where:Set }
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
function add(raw, where) {
  if (!HAN.test(raw)) return;
  let s = norm(raw);
  if (!s || !HAN.test(s)) return;
  // 자리표시자 번호를 등장 순서대로 다시 매김
  let n = 0; s = s.replace(/\{(\d+)\}/g, () => `{${n++}}`);
  if (!keys.has(s)) keys.set(s, { ph: n, where: new Set() });
  keys.get(s).where.add(where);
}

// 한 조각(HTML 이 섞일 수 있는 문자열)을 텍스트 노드·속성 단위로 잘라 추가
function addMarkup(str, where) {
  if (!str.includes('<')) { add(str, where); return; }
  // 태그 안의 속성값
  str.replace(/<[a-zA-Z][^>]*>/g, tag => {
    for (const a of ATTRS) {
      const re = new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'g');
      let m; while ((m = re.exec(tag))) add(m[2] ?? m[3] ?? '', where + '#attr');
    }
    return tag;
  });
  // 태그 밖 텍스트
  str.split(/<[^>]*>/).forEach(t => add(t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), where));
}

// ---- 1) 정적 HTML (script/style 제외) ----
const scripts = [];
const staticHtml = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, body) => { scripts.push({ attrs, body }); return ''; }).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
addMarkup(staticHtml, 'html');

// ---- 2) 스크립트 ----
function nameOf(node) { return node && (node.name || (node.type === 'Literal' && String(node.value)) || ''); }
let parsedBlocks = 0;
for (const sc of scripts) {
  if (/\bsrc\s*=/.test(sc.attrs) || !sc.body.trim()) continue;
  let ast;
  try { ast = acorn.parse(sc.body, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
  catch (e) { console.error('파싱 실패:', (sc.attrs || '').trim() || '(main)', e.message); continue; }
  parsedBlocks++;
  const where = ((sc.attrs.match(/id="([^"]+)"/) || [])[1]) || 'main';
  walk.ancestor(ast, {
    Literal(node, st, anc) {
      if (typeof node.value !== 'string' || !HAN.test(node.value)) return;
      if (skip(node, anc)) return;
      addMarkup(node.value, where);
    },
    TemplateLiteral(node, st, anc) {
      const s = node.quasis.map(q => q.value.cooked ?? q.value.raw).reduce((acc, part, i) => acc + part + (i < node.expressions.length ? `{${i}}` : ''), '');
      if (!HAN.test(s)) return;
      if (skip(node, anc)) return;
      addMarkup(s, where);
    }
  });
}

// 제외 규칙
function skip(node, anc) {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i];
    if (a.type === 'VariableDeclarator' && /prompt/i.test(nameOf(a.id))) return true;
    if ((a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression') && a.id && /prompt/i.test(a.id.name)) return true;
    if (a.type === 'Property' && /prompt/i.test(nameOf(a.key)) && !a.computed) return true;
    if (a.type === 'VariableDeclarator' && nameOf(a.id) === 'NAME_TO_TICKER_MAP') return true;
    if (a.type === 'CallExpression' && a.callee && /^(callGemini)$/.test(a.callee.name || '') && a.arguments[0] === anc[i + 1]) return true;
  }
  // 객체 키로 쓰인 한글 리터럴(검색용 사전 등)은 제외: Property.key === node
  const parent = anc[anc.length - 2];
  if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) return true;
  return false;
}

// ---- 3) 저장 ----
const list = [...keys.entries()].map(([ko, v], i) => ({ id: i, ko, ph: v.ph, where: [...v.where][0] }));
list.sort((a, b) => a.ko.localeCompare(b.ko, 'ko'));
list.forEach((x, i) => { x.id = i; });
fs.mkdirSync(path.join(root, 'i18n'), { recursive: true });
fs.writeFileSync(path.join(root, 'i18n', 'ko_keys.json'), JSON.stringify(list, null, 0));
const chars = list.reduce((s, x) => s + x.ko.length, 0);
const byWhere = {}; list.forEach(x => { byWhere[x.where] = (byWhere[x.where] || 0) + 1; });
console.log(`추출 완료: ${list.length}개 문구 (${chars}자), 파싱한 스크립트 ${parsedBlocks}개`);
console.log('출처별:', JSON.stringify(byWhere));
console.log('자리표시자 포함:', list.filter(x => x.ph > 0).length);
