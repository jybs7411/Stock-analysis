#!/usr/bin/env python3
"""index.html 이 쓰는 Tailwind 색상 클래스를 훑어 '밝은 모드' 덮어쓰기 CSS 를 만들어 index.html 의 마커 사이에 넣는다.
 - 기본(어두운/OLED) 스타일은 건드리지 않고, html[data-theme="light"] 아래의 규칙만 만든다.
 - 어두운 배경·밝은 글자 계열을 밝은 배경·어두운 글자로 뒤집고(slate 700~950, 흰 글자, 색조 200~400 글자/800~950 배경·테두리), 채도 높은 버튼의 흰 글자는 유지한다.
 - index.html 에 새 색상 클래스를 추가했다면 다시 실행: cd tools && python3 gen-light-theme.py
사용: python3 gen-light-theme.py"""
import json, os, re, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'index.html')
BEGIN, END = '/* LIGHT-THEME:BEGIN (tools/gen-light-theme.py 가 생성 — 직접 고치지 말 것) */', '/* LIGHT-THEME:END */'

pal = json.loads(subprocess.check_output(['node', '-e', "const c=require('tailwindcss/colors');const o={};for(const k of ['slate','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose'])o[k]=c[k];console.log(JSON.stringify(o))"], cwd=os.path.join(ROOT, 'tools')))
HUES = [h for h in pal if h != 'slate']

def rgb(hx):
    hx = hx.lstrip('#')
    if len(hx) == 3: hx = ''.join(c * 2 for c in hx)
    return tuple(int(hx[i:i + 2], 16) for i in (0, 2, 4))
def lum(hx):
    f = lambda v: (v / 255 / 12.92) if v / 255 <= 0.03928 else (((v / 255) + 0.055) / 1.055) ** 2.4
    r, g, b = rgb(hx); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def css(hx, a=None):
    r, g, b = rgb(hx)
    return f'rgb({r} {g} {b} / {a})' if a is not None else f'rgb({r} {g} {b})'
def mix_white(hx, t):
    r, g, b = rgb(hx); return '#%02x%02x%02x' % tuple(round(v + (255 - v) * t) for v in (r, g, b))

SLATE_BG = {'950': '#f1f5f9', '900': '#f8fafc', '800': '#e2e8f0', '700': '#cbd5e1'}
SLATE_TEXT = {'50': '#0f172a', '100': '#0f172a', '200': '#1e293b', '300': '#334155', '400': '#475569', '500': '#5b6b82', '600': '#64748b', '700': '#475569'}
SLATE_BORDER = {'950': '#e2e8f0', '900': '#e2e8f0', '800': '#e2e8f0', '700': '#cbd5e1', '600': '#cbd5e1', '500': '#94a3b8', '400': '#94a3b8'}
SLATE_PH = {'500': '#94a3b8', '400': '#94a3b8'}
ARB = {'#000000': '#f1f5f9', '#0b0e13': '#ffffff', '#07090c': '#f8fafc', '#12161c': '#f1f5f9', '#1e293b': '#e2e8f0', '#1c222b': '#e2e8f0'}

def hue_map(kind, hue, shade):
    """(색 hex, 알파 배율) 또는 None(그대로 둠)"""
    p = pal[hue]
    if kind == 'text':
        if shade in ('50', '100', '200'): return p['800'], 1
        if shade in ('300', '400'): return p['700'], 1
        if shade == '500': return p['600'], 1
    elif kind in ('bg', 'from', 'via', 'to'):
        if shade == '950': return p['50'], 1.4
        if shade == '900': return p['100'], 1.6
        if shade == '800': return p['100'], 1.6
        if shade in ('700', '600') : return None
    elif kind in ('border', 'divide', 'ring'):
        if shade in ('950', '900', '800'): return p['200'], 1
        if shade in ('700', '600'): return p['300'], 1
    return None

def slate_map(kind, shade):
    if kind == 'text': t = SLATE_TEXT.get(shade); return (t, 1) if t else None
    if kind in ('bg', 'from', 'via', 'to'): t = SLATE_BG.get(shade); return (t, 1) if t else None
    if kind in ('border', 'divide', 'ring'): t = SLATE_BORDER.get(shade); return (t, 1) if t else None
    if kind == 'placeholder': t = SLATE_PH.get(shade); return (t, 1) if t else None
    return None

html = open(HTML, encoding='utf-8').read()
body = html
if BEGIN in body:  # 이전에 만든 블록 제외하고 스캔
    body = body[:body.index(BEGIN)] + body[body.index(END) + len(END):]

KINDS = 'bg|text|border|from|via|to|divide|ring|placeholder'
PREF = r'(?:(?:hover|focus|disabled|group-hover|focus-within|sm|md|lg|xl|active|placeholder):)*'
HUE_RE = '|'.join(HUES + ['slate', 'white'])
tok_re = re.compile(r'(?<![\w\-:\[#])(' + PREF + r')(' + KINDS + r')-(?:(' + HUE_RE + r')(?:-(\d{2,3}))?|\[(#[0-9a-fA-F]{3,6})\])(?:/(\d{1,3}))?(?![\w\-\[])')
BP = {'sm': 640, 'md': 768, 'lg': 1024, 'xl': 1280}
esc = lambda c: re.sub(r'([^\w\-])', r'\\\1', c)

rules = {}  # (media, selector) -> decls
sats = set()
def add(media, sel, decl):
    rules.setdefault((media, sel), set()).add(decl)

for m in tok_re.finditer(body):
    pref, kind, hue, shade, arb, alpha = m.groups()
    token = m.group(0)
    a = (int(alpha) / 100) if alpha else None
    if hue == 'white':
        if shade: continue
        if kind == 'text': col = '#0f172a'
        elif kind in ('bg', 'border'): col = '#0f172a'
        else: continue
        res = (col, 1)
        if kind == 'bg' and a is None: continue  # bg-white 는 그대로
    elif arb:
        if kind == 'text': continue
        hx = arb.lower()
        if len(hx) == 4: hx = '#' + ''.join(c * 2 for c in hx[1:])
        if lum(hx) > 0.35: continue
        col = ARB.get(hx) or mix_white(hx, 0.9)
        res = (col, 1)
    elif hue == 'slate':
        res = slate_map(kind, shade)
        if not res: continue
    else:
        res = hue_map(kind, hue, shade)
        if kind in ('bg', 'from', 'via', 'to', 'border') and hue != 'slate' and shade in ('500', '600', '700', '800') and kind in ('bg', 'from') and (a is None or a >= 0.7):
            sats.add(token)
        if not res: continue
    col, mult = res
    if kind in ('bg', 'from') and hue not in ('slate', 'white') and not arb and shade in ('500', '600', '700') and (a is None or a >= .7): sats.add(token)
    if a is not None and mult != 1: a = min(0.95, a * mult)
    if a is not None and hue not in ('slate', 'white') and not arb and kind == 'bg' and shade in ('950', '900', '800') and False: pass
    cval = css(col, a)
    prefs = [x for x in pref.split(':') if x]
    media = None; pseudo = ''; pre = ''
    for x in prefs:
        if x in BP: media = BP[x]
        elif x == 'hover': pseudo += ':hover'
        elif x == 'focus': pseudo += ':focus'
        elif x == 'disabled': pseudo += ':disabled'
        elif x == 'active': pseudo += ':active'
        elif x == 'focus-within': pseudo += ':focus-within'
        elif x == 'group-hover': pre = '.group:hover '
        elif x == 'placeholder': pseudo += '::placeholder'
    base = 'html[data-theme="light"] body ' + pre
    cls = '.' + esc(token)
    if kind == 'bg': add(media, base + cls + pseudo, f'background-color:{cval}')
    elif kind == 'text': add(media, base + cls + pseudo, f'color:{cval}')
    elif kind == 'border': add(media, base + cls + pseudo, f'border-color:{cval}')
    elif kind == 'divide': add(media, base + cls + ' > :not([hidden]) ~ :not([hidden])', f'border-color:{cval}')
    elif kind == 'ring': add(media, base + cls + pseudo, f'--tw-ring-color:{cval}')
    elif kind == 'placeholder': add(media, base + cls + '::placeholder', f'color:{cval}')
    elif kind == 'from':
        add(media, base + cls + pseudo, f'--tw-gradient-from:{cval} var(--tw-gradient-from-position);--tw-gradient-to:{css(col, 0)} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)')
    elif kind == 'via':
        add(media, base + cls + pseudo, f'--tw-gradient-to:{css(col, 0)} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),{cval} var(--tw-gradient-via-position),var(--tw-gradient-to)')
    elif kind == 'to':
        add(media, base + cls + pseudo, f'--tw-gradient-to:{cval} var(--tw-gradient-to-position)')

# 채도 높은 배경 위의 흰 글자는 그대로 흰색
sat_sel = ','.join('.' + esc(t) for t in sorted(sats) if ':' not in t) + ',.bg-gradient-to-tr,.bg-gradient-to-r.from-cyan-500'
sat_rule = f'html[data-theme="light"] body :is({sat_sel}).text-white, html[data-theme="light"] body :is({sat_sel}) .text-white, html[data-theme="light"] body :is({sat_sel}) :is(i,span,b):not([class*="text-"]) {{color:#fff}}'

# 인라인 style 의 밝은 강조색(글자) → 같은 색조의 진한 색
inline = set(re.findall(r'color:\s*[\'"]?(#[0-9a-fA-F]{6})\b', body))
def darken(hx):
    r, g, b = [v / 255 for v in rgb(hx)]
    import colorsys
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l < 0.5 or s < 0.25: return None
    r, g, b = colorsys.hls_to_rgb(h, 0.36, min(1, s))
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))
inl = []
for hx in sorted(inline):
    d = darken(hx)
    if d:
        for sp in ('', ' '):
            inl.append(f'html[data-theme="light"] body [style*="color:{sp}{hx}" i]{{color:{d} !important}}')

out = [BEGIN]
by_media = {}
for (media, sel), decls in rules.items(): by_media.setdefault(media, []).append(f'{sel}{{{";".join(sorted(decls))}}}')
for media in sorted(by_media, key=lambda x: (x is not None, x or 0)):
    # 그라데이션은 from → via → to 순서여야 서로의 변수를 덮어쓰지 않는다 (Tailwind 와 같은 순서)
    gk = lambda r: (0 if '--tw-gradient-from:' in r else 1 if 'gradient-via-position' in r else 2 if '--tw-gradient-to:' in r else -1, r)
    chunk = '\n'.join(sorted(by_media[media], key=gk))
    out.append(chunk if media is None else f'@media (min-width:{media}px){{\n{chunk}\n}}')
out.append(sat_rule)
out.extend(inl)
out.append(END)
block = '\n'.join(out)
if BEGIN in html:
    html = html[:html.index(BEGIN)] + block + html[html.index(END) + len(END):]
else:
    anchor = '  </style>\n</head>'
    assert anchor in html, 'style 끝을 찾지 못함'
    html = html.replace(anchor, block + '\n' + anchor, 1)
open(HTML, 'w', encoding='utf-8').write(html)
print(f'규칙 {sum(len(v) for v in by_media.values())}개, 채도 높은 배경 {len(sats)}개, 인라인 색 {len(inl)}개, {len(block) // 1024}KB')
