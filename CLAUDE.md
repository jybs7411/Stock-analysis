# PentAnalyst — 작업 규칙 (토큰 절약)

단일 파일 프론트엔드 `index.html`(18.6k줄, 1.5MB) + Cloudflare Worker 프록시. 한국어 UI.

## 절대 규칙
- `index.html` 전체를 Read 하지 말 것. **Grep으로 함수/ID를 찾고 → Read는 offset/limit로 ~150줄만.**
- `docs/`는 `tools/build.py`가 만든 **생성물**(index.html 복사본 포함). 읽기·검색·수정 금지. 소스는 항상 루트 `index.html`.
- `i18n/ko_keys.json`(400KB), `tools/package-lock.json`, `node_modules/`, `i18n/work/`는 읽지 말 것. 필요하면 스크립트/`jq`/`grep`으로 일부만.
- diff는 `git diff --stat` 또는 `git diff -- <파일>`. `docs/` 포함 전체 diff 출력 금지.
- 대량·기계적 작업(일괄 치환, 검사, i18n 추출)은 스크립트로 하고 요약만 확인.
- 파일 삭제·덮어쓰기·이름 변경·이동은 먼저 사용자에게 확인.

## index.html 구조 (줄 번호는 수정 시 어긋나므로 `<script id=...>`로 찾기: `grep -n '<script' index.html`)
| 블록 | 역할 | 전역 접두 |
|---|---|---|
| `i18n-boot`, `i18n-engine` | 언어 선택·번역 엔진 | — |
| 무ID 메인 스크립트 (대략 1377~8589) | 메인 차트(CH)·지표(TA)·분석/AI·스크리너·공용 헬퍼(fetchSpark, fetchQuotes, callGemini, quickSearch, showToast) | — |
| `mod-bdw-notes` | 불단왕 탭 셸·강의 정리·계산기·매매일지 | bdw |
| `mod-bdw` | 불단왕 종목 분석 엔진·화면·차트 (임계값 상수는 파일 상단) | bdw / BDW_ |
| `mod-prevday` | 전일 복기(5분봉, Brooks 날 유형) | pd / PD_ |
| `mod-fx` | 환율 탭 (FX_PAIRS 표 편집) | fx / FX_ |
| `mod-market` | 시장·매크로 탭(히트맵, 섹터, 매크로) | mk / MK_ |
| `mod-multi` | 멀티 차트 2×2 | — |
| `mod-valcalc` | 밸류에이션 계산기 `window.valCalcRender` | val |
| `mod-signals` | 신호 엔진 `window.taSignalsLite` (관심종목·스크리너용) | — |
| `mod-watch` | 관심종목 탭(저장·알림·리스크) | watch / wl |

모듈은 메인 스크립트의 공용 헬퍼만 호출하고 자기 DOM 루트(#fxRoot, #multiRoot, #watchRoot…) 안에서만 작동한다. 수정 대상 모듈만 열 것.

## 기타 디렉터리
- `worker/index.js` — Yahoo 프록시 Worker (`/api/spark`, `/api/quotes` 등). 변경 시 재배포 필요.
- `tools/` — `build.py`(index.html→docs/), `i18n-extract.mjs`/`i18n-build.mjs`/`i18n-merge.py`(번역). index.html을 고친 뒤 docs 갱신: `cd tools && python3 build.py`.
- `pwa/`, `site/` — PWA 자산·Pages 배포 설정.

## 세션 습관
- 작업이 바뀌면 `/clear`, 이어가야 하면 `/compact <유지할 내용>`. 토큰 확인은 `/context`.
- 요청은 구체적으로(모듈 + 함수/기능 이름). 단순 수정은 낮은 effort/Sonnet.
