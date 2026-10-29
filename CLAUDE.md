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

## Google Drive 동기화 (통합)
- 모든 저장 데이터(`pentanalyst_*` localStorage 키)는 메인 스크립트의 `GSYNC`(GAUTH 바로 아래)가 Drive 파일 하나(`pentanalyst_sync.json`)로 저장·복원한다. 모듈별 개별 Drive 동기화를 새로 만들지 말 것.
- 항목 삭제는 `GSYNC`의 `COLLS`에 등록된 컬렉션(관심종목·장부·불단왕 일지·스크리너 노트)만 삭제 표시(툼스톤)로 전파한다. 새 목록형 데이터는 `COLLS`에 경로·id 필드를 추가하면 된다.
- 새 데이터 키는 자동 포함된다. 제외할 키(캐시·화면 배치·기기 고유값)는 `GSYNC`의 `EXCLUDE` 정규식에, 항목 단위로 합쳐야 하는 키는 `MERGERS`에 추가한다.

## 브릿지 (Claude 아티팩트 "주식 데스크" 연동)
- `BRIDGE`(`<script id="mod-bridge">`)는 백업 동기화가 아니라 Claude 아티팩트와의 데이터 교환이라 `GSYNC`와 별개다. 캐시·파일 id 키(`pentanalyst_bridge_*`)는 `GSYNC`의 `EXCLUDE`로 동기화에서 제외한다.
- 인증은 `GAUTH`를 공유하되, 로그인·동기화 권한(`SCOPE`)은 건드리지 않고 `GAUTH.getBridgeToken`이 `drive.readonly`+`drive.file`을 필요할 때만 추가 동의로 받는다.
- 읽기: 드라이브 폴더 `주식데스크-브릿지`(이름으로 검색)의 `claude_analysis_YYYYMMDD-HHMM.json` 중 최신(TEST 제외) → 'Claude 분석' 탭(`claude`, 표시 전용). 외부 파일이므로 `<b><i><br>`만 허용하고 나머지는 이스케이프, 링크는 http(s)만.
- 쓰기: 드라이브 루트 `pentanalyst_quotes.json`(`claude-bridge/quotes@1`)을 같은 파일 id로 덮어쓴다(제목 변경 금지). 스크리너가 받아 둔 일봉(`SCREENER_MASTER_DATA[].hist`)을 우선 쓰고, 없는 종목만 `fetchSpark`로 채운다.
- 규격: 분석 파일은 모든 최상위 필드가 선택(`macro`/`screens`/`pullbacks`/`alerts`)이며 없으면 해당 카드를 숨긴다. 스키마를 바꾸면 웹의 Claude 쪽에도 알린다.

## 프로젝트 문서 (`project-docs/`)
- 앱·주식 데스크·브릿지의 원칙/구조/결정/로드맵은 `project-docs/`가 원본이다. **개선·구조 변경 작업 전에 `project-docs/README.md`(한 장 요약)부터 읽는다.** 상세는 필요한 문서만 연다.
- 원칙: 앱 = 수집·계산·표시, 주식 데스크 = Claude만 가능한 일. 새 기능은 `PRINCIPLES.md`의 판별 질문으로 위치를 정한다.
- 브릿지 스키마·점수/판정 로직·모듈 구조를 바꿨다면 같은 커밋에서 `ARCHITECTURE.md`를, 방향을 정했다면 `DECISIONS.md`에 한 줄을, 개선 항목 진행 시 `ROADMAP.md`를 갱신한다. 문서에 줄 번호는 쓰지 않는다.
- `project-docs/`는 생성물이 아니다(`docs/`와 혼동 금지). 문서만 바꾼 커밋은 `APP_VERSION`을 올리지 않는다.

## 버전 규칙
- 앱 버전은 `index.html`의 `const APP_VERSION`(메인 스크립트, `switchAppTab` 위)이 단일 출처이며 화면 맨 아래 푸터(`#appVersion`)에 표시된다.
- **앱을 수정(업데이트)할 때마다 `APP_VERSION`을 올린다.** 기능 추가·동작 변경은 minor(1.1.0→1.2.0), 버그 수정·문구 수정은 patch(1.1.0→1.1.1).

## 규칙 엔진 (`mod-rules`) 변경 시
- 순수 함수 모음이다(DOM·네트워크 금지). 임계값은 `CFG` 한 곳에 둔다. 규칙을 바꾸면 `python3 tools/gen-rules-golden.py`로 골든(`tools/rules-golden.json`)을 다시 만들고 `node tools/test-rules.mjs`가 통과해야 한다. 규칙을 바꾸는 이유는 `project-docs/DECISIONS.md`에 남긴다.

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
| `mod-rules` | 규칙 엔진 `window.RuleEngine` (규칙 점수·판정·지지/매수/손절/목표, 순수 함수) | — |
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
