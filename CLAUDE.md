# PentAnalyst — 작업 규칙 (토큰 절약)

단일 파일 프론트엔드 `index.html`(18.6k줄, 1.5MB) + Cloudflare Worker 프록시. 한국어 UI.

## 절대 규칙
- `index.html` 전체를 Read 하지 말 것. **Grep으로 함수/ID를 찾고 → Read는 offset/limit로 ~150줄만.**
- `docs/`는 `tools/build.py`가 만든 **생성물**(index.html 복사본 포함). 읽기·검색·수정 금지. 소스는 항상 루트 `index.html`.
- `i18n/*.json`·`i18n/*.js`(번역 사전, 각 400~500KB; en/de 완성), `tools/package-lock.json`, `node_modules/`, `i18n/work/`는 읽지 말 것. 필요하면 스크립트/`jq`/`grep`으로 일부만.
- diff는 `git diff --stat` 또는 `git diff -- <파일>`. `docs/` 포함 전체 diff 출력 금지.
- 대량·기계적 작업(일괄 치환, 검사, i18n 추출)은 스크립트로 하고 요약만 확인.
- 파일 삭제·덮어쓰기·이름 변경·이동은 먼저 사용자에게 확인.

## 작업 시작 전 동기화 (로컬·원격 버전 불일치 방지)
- **세션 첫 작업 전에 반드시** `git fetch` 후 `git status -sb`로 `origin/main` 대비 뒤처짐(behind)을 확인하고, 뒤처졌으면 `git pull --ff-only origin main`으로 먼저 받는다. 작업 중 변경이 있으면 커밋/스태시 후 진행. 사용자에게 한 줄로 결과(예: "origin/main과 동일, 현재 v1.5.0")를 알린다.
- `APP_VERSION`은 **원격 최신 값을 기준으로** 올린다(로컬 값 기준 금지). 푸시 전에 `git fetch`로 원격이 또 앞서지 않았는지 재확인한다.
- 충돌 시 `docs/`·`i18n/ko_keys.json`·`i18n/*.js` 는 생성물이므로 수동 병합하지 말고 아무 쪽이나 취한 뒤 `build.py`/`i18n-extract`/`i18n-build`로 재생성한다. 실제 소스 충돌(주로 `APP_VERSION` 줄)만 직접 해결한다.
- 기본 배포 브랜치는 `main`. 푸시·커밋은 사용자가 요청할 때만 한다.

## 버전 규칙
- 앱 버전은 `index.html`의 `const APP_VERSION`(메인 스크립트, `switchAppTab` 위)이 단일 출처이며 화면 맨 아래 푸터(`#appVersion`)에 표시된다.
- **앱을 수정(업데이트)할 때마다 `APP_VERSION`을 올린다.** 기능 추가·동작 변경은 minor(1.1.0→1.2.0), 버그 수정·문구 수정은 patch(1.1.0→1.1.1).

## 탭 간 종목 동기화
- 어느 탭에서든 종목을 고르면 `appSetSymbol(sym, 탭id)`로 공용 '현재 종목'(`APP_SYM`)을 갱신한다. 다른 탭은 열릴 때 `APP_SYM_APPLY[탭id]`로 그 종목에 맞춘다(`switchAppTab` → `appSyncTab`).
- 새 탭/모듈이 종목을 다룬다면: 종목이 확정되는 지점에서 `appSetSymbol`을 호출하고, `APP_SYM_APPLY.<탭id>`를 등록한다.

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

## 다국어(ko/en/de)
- 엔진은 `index.html`의 `i18n-boot`/`i18n-engine`, 사전은 `i18n/{en,de}.js`(생성물). 문구를 바꾼 뒤: `cd tools && node i18n-extract.mjs`(키 추출) → 새 키만 번역해 `i18n/work/*.tsv`에 추가 → `python3 i18n-merge.py && node i18n-build.mjs && python3 build.py`.
- 새 UI 문구를 한국어로 추가했다면 사전을 통째로 읽지 말고 `grep -c`/스크립트로 누락 키만 확인.

## 세션 습관
- 작업이 바뀌면 `/clear`, 이어가야 하면 `/compact <유지할 내용>`. 토큰 확인은 `/context`.
- 요청은 구체적으로(모듈 + 함수/기능 이름). 단순 수정은 낮은 effort/Sonnet.
