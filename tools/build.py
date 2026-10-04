#!/usr/bin/env python3
"""index.html(소스) → docs/ (폰에서 설치·사용하기 좋은 배포본) 만들기.

 - Tailwind CDN(브라우저에서 매번 계산) 대신 미리 빌드한 app.css 사용
 - FontAwesome 을 docs/fa/ 에 함께 넣어 자체 제공
 - manifest·서비스 워커·아이콘 복사 (홈 화면 설치, 앱 껍데기 오프라인)
사용: cd tools && npm install && python3 build.py   (index.html 을 고칠 때마다 다시 실행 후 docs/ 를 커밋)
"""
import hashlib, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, 'tools')
OUT = os.path.join(ROOT, 'docs')
src = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()

# 1) CSS 빌드
os.makedirs(OUT, exist_ok=True)
css_path = os.path.join(OUT, 'app.css')
tw = os.path.join(TOOLS, 'node_modules', '.bin', 'tailwindcss.cmd' if os.name == 'nt' else 'tailwindcss')
if not os.path.exists(tw):
    sys.exit('먼저 tools 폴더에서 npm install 을 실행하세요.')
subprocess.run([tw, '-c', 'tailwind.config.js', '-i', 'in.css', '-o', css_path, '--minify'], cwd=TOOLS, check=True, stderr=subprocess.DEVNULL)

# 2) FontAwesome (woff2 만)
fa_src = os.path.join(TOOLS, 'node_modules', '@fortawesome', 'fontawesome-free')
fa_out = os.path.join(OUT, 'fa')
shutil.rmtree(fa_out, ignore_errors=True)
os.makedirs(os.path.join(fa_out, 'css'))
os.makedirs(os.path.join(fa_out, 'webfonts'))
shutil.copy(os.path.join(fa_src, 'css', 'all.min.css'), os.path.join(fa_out, 'css'))
for f in os.listdir(os.path.join(fa_src, 'webfonts')):
    if f.endswith('.woff2'):
        shutil.copy(os.path.join(fa_src, 'webfonts', f), os.path.join(fa_out, 'webfonts'))

# 3) index.html 변환
html = src
n0 = len(html)
html = html.replace('<script src="https://cdn.tailwindcss.com"></script>', '<link rel="stylesheet" href="app.css">')
html, k = re.subn(r'\s*<script>\s*tailwind\.config = \{.*?\n  </script>', '', html, count=1, flags=re.S)
assert k == 1, 'tailwind.config 블록을 찾지 못했습니다'
fa_cdn = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
assert fa_cdn in html
html = html.replace(fa_cdn, 'fa/css/all.min.css')
assert 'cdn.tailwindcss.com' not in html
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(html)

# 4) PWA 파일
shutil.copy(os.path.join(ROOT, 'pwa', 'manifest.webmanifest'), OUT)
shutil.rmtree(os.path.join(OUT, 'icons'), ignore_errors=True)
shutil.copytree(os.path.join(ROOT, 'pwa', 'icons'), os.path.join(OUT, 'icons'))
# 번역 사전(i18n/en.js, de.js) 복사 — 선택한 언어일 때만 앱이 읽는다
shutil.rmtree(os.path.join(OUT, 'i18n'), ignore_errors=True)
os.makedirs(os.path.join(OUT, 'i18n'))
for lang in ('en', 'de'):
    src_js = os.path.join(ROOT, 'i18n', lang + '.js')
    if os.path.exists(src_js):
        shutil.copy(src_js, os.path.join(OUT, 'i18n', lang + '.js'))
h = hashlib.sha1()
for p in [os.path.join(OUT, 'index.html'), css_path] + sorted(os.path.join(OUT, 'i18n', f) for f in os.listdir(os.path.join(OUT, 'i18n'))):
    h.update(open(p, 'rb').read())
sw = open(os.path.join(ROOT, 'pwa', 'sw.js'), encoding='utf-8').read().replace('__BUILD__', h.hexdigest()[:10])
open(os.path.join(OUT, 'sw.js'), 'w', encoding='utf-8').write(sw)
open(os.path.join(OUT, '.nojekyll'), 'w').write('')  # GitHub Pages 가 파일을 가공하지 않게

size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT) for f in fs)
print(f'docs/ 생성 완료: app.css {os.path.getsize(css_path)//1024}KB, index.html {os.path.getsize(os.path.join(OUT,"index.html"))//1024}KB, 전체 {size//1024}KB')
