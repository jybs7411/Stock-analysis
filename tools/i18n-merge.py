#!/usr/bin/env python3
"""i18n/work/{en,de}_NN.tsv (id<TAB>번역) 을 합쳐 i18n/{en,de}.json (한국어→번역 맵)을 만든다.
 - 입력은 i18n/work/in_NN.tsv (id<TAB>출처<TAB>한국어)
 - 자리표시자 {n} 불일치·누락·한글 잔존을 보고한다.
 - 이미 있는 i18n/{lang}.json 이 있으면 그 위에 덮어쓴다(수동 보정 보존): --fresh 이면 새로 시작
사용: python3 tools/i18n-merge.py [--fresh]"""
import glob, json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(ROOT, 'i18n', 'work')
keys = {k['id']: k['ko'] for k in json.load(open(os.path.join(ROOT, 'i18n', 'ko_keys.json'), encoding='utf-8'))}
fresh = '--fresh' in sys.argv
ph = lambda s: sorted(re.findall(r'\{\d+\}', s))
for lang in ('en', 'de'):
    out_path = os.path.join(ROOT, 'i18n', f'{lang}.json')
    out = {} if fresh or not os.path.exists(out_path) else json.load(open(out_path, encoding='utf-8'))
    got = {}
    for f in sorted(glob.glob(os.path.join(W, f'{lang}_*.tsv'))):
        for ln, line in enumerate(open(f, encoding='utf-8').read().split('\n'), 1):
            if not line.strip(): continue
            p = line.split('\t', 1)
            if len(p) != 2 or not p[0].strip().isdigit():
                print(f'  형식 오류 {os.path.basename(f)}:{ln}: {line[:60]!r}'); continue
            got[int(p[0])] = p[1].strip()
    bad_ph = []; han = []; miss = []
    for i, ko in keys.items():
        t = got.get(i)
        if t is None: miss.append(i); continue
        if ph(ko) != ph(t): bad_ph.append(i); continue
        if re.search(r'[가-힣]', t): han.append(i)
        out[ko] = t
    json.dump(out, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    json.dump({'missing': miss, 'placeholder': bad_ph, 'hangul': han}, open(os.path.join(W, f'{lang}.report.json'), 'w'))
    print(f'{lang}: 번역 {len(got)}/{len(keys)}, 누락 {len(miss)}, 자리표시자 불일치 {len(bad_ph)}, 한글 잔존 {len(han)} → {os.path.relpath(out_path, ROOT)} ({len(out)}개)')
