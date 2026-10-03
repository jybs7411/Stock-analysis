# PentAnalyst — Claude 작업 안내 (토큰 절약용)

한국어 UI 주식 터미널. 소스는 단일 파일 `index.html`(약 1.5MB, 한 번에 읽지 말 것) + Cloudflare Worker `worker/index.js`.
사용자는 한국어로 대화한다. 개인 투자자용 교육 도구: **데이터를 지어내지 않는다(없으면 빈칸), 투자 권유 아님 톤.**

## 읽지 말 것 / 검색하지 말 것 (큰 파일·생성물)
- `docs/` — `tools/build.py` 가 만드는 배포본(index.html 복사본 포함). 수정·검색 대상 아님.
- `i18n/ko_keys.json`, `i18n/en.js`, `i18n/de.js`, `i18n/*.json`, `i18n/work/` — 번역 사전·작업물(수백 KB).
- `tools/package-lock.json`, `node_modules/`, `.claude/worktrees/`
- `index.html` 은 통째로 Read 금지: `Grep -n` 으로 함수/ID 를 찾고 **그 주변 100~150줄만** `Read(offset, limit)`.

## index.html 구조 (줄 번호 대신 이름으로 찾기)
- `<script id="i18n-boot">`, `<script id="i18n-engine">` — 언어 선택(ko/en/de)·화면 자동 번역
- 메인 `<script>` — 공용 헬퍼(fetch*, TA 라이브러리, STUDY_DEFS, CHART_PRESETS, 차트 엔진 `CH`/`ch*`, 스크리너, composeAnalysis, callGemini, 탭 `switchAppTab`/`TAB_HOOKS`)
- 탭 모듈(각각 `<script id="mod-…">`): `mod-bdw-notes`·`mod-bdw`(불단왕), `mod-prevday`, `mod-fx`, `mod-market`, `mod-multi`(2×2 차트), `mod-valcalc`(밸류에이션 계산기), `mod-signals`(`taSignalsLite`), `mod-watch`(관심종목)
- 탭 화면은 `#view-<id>`, 버튼은 `#tabBtn-<id>`; 모듈은 `TAB_HOOKS[id]` 에 "탭 열릴 때" 함수를 등록한다.
- Tailwind 클래스는 소스에 **완성형 문자열**로 써야 한다(빌드가 소스를 스캔). `bg-${c}-500` 같은 조립 금지.

## 작업 규칙
- 한 번에 한 모듈/함수만 수정. 같은 일은 스크립트로(예: `tools/i18n-extract.mjs`). 큰 diff 는 `git diff --stat` 먼저.
- 수정 후: 스크립트 문법 검사(`<script>` 본문을 뽑아 `node --check`) → `cd tools && python3 build.py`(docs/ 재생성) → 커밋 → 푸시.
- 커밋 메시지는 한국어, 끝에 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 와 `Claude-Session: …` 줄. 푸시는 `claude/pentanalyst-debug-teh7gz` 브랜치로만(`git push -u origin <branch>`). PR 은 사용자가 요청할 때만.
- 서브에이전트·병렬 작업은 **사용자가 원할 때만**, 개수는 최소로(각각 수만~수십만 토큰을 쓴다). Workflow 도구는 사용자가 직접 요청했을 때만.
- Gemini 호출은 설정·버튼에 따라서만(무료 키 일반 호출 / 유료 키는 검색 Grounding 전용). Yahoo 는 샌드박스에서 접속 불가 → 목업으로 테스트하고 실제로 확인 못 한 것은 그대로 보고.
- Worker 코드가 바뀌면 사용자가 Cloudflare 에서 다시 배포해야 함을 알린다.

## 테스트
테스트·목업 스크립트는 레포 밖 스크래치패드에 있어 세션이 끝나면 사라질 수 있다. 필요하면 `tools/` 아래로 옮겨 커밋할 것.
