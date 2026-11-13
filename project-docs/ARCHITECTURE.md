# 구조 (2026-10-29 기준, 앱 v1.74.0)

> 줄 번호 없음. 함수·모듈명으로 찾는다. 읽지 못한 부분은 KNOWN_GAPS.md.

## 1. PentAnalyst
**배포**: `index.html` 단일 파일(약 27.5k줄, `<script id="mod-*">` 모듈) + Cloudflare Worker `stock-analysis`(`worker/index.js`, `docs/` 정적 서빙 + `/api/*`). 인증/저장은 `GAUTH`/`GSYNC`(Drive `pentanalyst_sync.json` 하나, 컬렉션 삭제는 툼스톤). 다국어 ko/en/de.

**Worker 데이터 계층**
- 소스: Yahoo(주) → Stooq/Finnhub(폴백), FRED, Fear&Greed.
- 라우트: spark, quotes, chart, fundamentals, deep, revisions, calendar, fred, feargreed, finnhub.
- Yahoo crumb 30분 캐시. 응답 캐시는 `X-Cache: HIT/MISS/STALE`, 소스 실패 시 최대 24시간 된 stale 캐시 반환.

**계산 계층**
- 차트/지표: 프로 차트(지표 27종, 드로잉, 스윙 프리셋 5종).
- `mod-signals`: `taSignalsLite`(관심종목·스크리너 칩), `taVetCheck`, `taSignalBacktest`.
- 스크리너: `SCREENER_MASTER_DATA`(약 412 티커), 큐(`enqueueScreener` → `pumpScreener`, 동시 8, `applyLiveToEntry`), 필터 50개/프리셋 12개, 점수 `scoreOf`(퀄리티·밸류·모멘텀).
- 그 외: 밸류에이션 계산기, 불단왕(`mod-bdw`), 전일 복기(`mod-prevday`), 환율, 시장·매크로(`mod-market`), 멀티차트, 관심종목(`mod-watch`).

**AI 계층 (Gemini)**
- `callGemini` 호출 지점 13곳. 그라운딩은 유료 키에서만.
- `executeAnalysis` → `composeAnalysis`(템플릿 전문가 문구, AI 아님; `buildVerifiedDataText`로 지표 주입) + `fetchGeminiGroundingAnalysis`(5 전문가 프롬프트).

**브릿지 모듈 `mod-bridge`**
- 폴더 `주식데스크-브릿지`.
- 읽기: 최신 `claude_analysis_YYYYMMDD-HHMM.json`(TEST 제외) → `validate` → 'Claude 분석' 탭(`macroCard`/`screensCard`/`pullbackCard`/`alertsCard`, 표시 전용). 허용 HTML `<b><i><br>`만, 링크 http(s)만.
- 쓰기(같은 파일 id로 PATCH, `drive.file`): `pentanalyst_quotes.json`(경량, `LIVE_EVERY_MS` 30분) / `pentanalyst_quotes_detail.json`(종가 63, OHLCV 130, 관심종목 400, `DETAIL_EVERY_MS` 3시간). 스크리너 일봉 재활용, 없는 종목만 `fetchSpark`. 장 상태 `usOpenNow`로 전송 판단.
- 관심종목 내보내기에 memo/thesis/qty/entry/buy/stop/target/group이 포함됨 (→ ROADMAP R-5).

**규칙 엔진 `mod-rules` (v1.75.0~)**: `window.RuleEngine` — 순수 함수(`score`/`levels`/`verdict`/`evaluate`/`pullbackAction`/`daysUntil`), 임계값은 `CFG` 한 곳. 기존 Python 규칙(`features.py score`·`insight.py verdict`)과 동작이 같게 이식했고, `tools/gen-rules-golden.py`(Python 원문을 oracle로 포함) → `tools/rules-golden.json` → `node tools/test-rules.mjs`로 대조한다. v1.76.0부터 브릿지 `quotes-detail`의 종목별 `rule` 필드로 내보낸다(아래 4. 스키마). 판정은 buy/hold/avoid(매수 금지); 'sell'(비중 축소 검토)은 화면에서 보유 종목에만. v1.77.0부터 'Claude 분석' 탭 카드에 출처 배지('규칙 신호 · 앱 계산' / 'Claude 리서치')를 붙이고, 보유 종목의 avoid/sell은 '비중 축소 검토'로 표시한다(`heldSet`, 화면 전용). v1.78.0부터 브릿지 내보내기 전에 `fillEarnings`가 매수 후보 종목의 실적일을 `fetchDeep`으로 채운다(캐시 `pentanalyst_bridge_earn_v1`, 동기화 제외). 스케줄 스크립트(`bridge/scripts`의 features/insight)는 상세 파일의 `rule`을 우선 사용하고, 없는 종목만 예전 Python 계산으로 대체한다.

## 2. 주식 데스크 (Claude 아티팩트, 약 607KB 단일 HTML)
URL: claude.ai/artifact/QFtKAXr7iBT1q8LGJJDw61. 런타임: `window.claude.use('db'|'mcp'|'sample'|'user'|'downloads')`.

- **저장소**: `Store`(db 우선, 로컬 폴백). DB 컬렉션: alerts/watch·latest·log, screens/*, snap/latest, macro/brief, insight/latest·ev·hist-YYYYMMDD, bridge/state, bridge/scripts, data/users/<uid>.
- **데이터**: `APPQ`(앱 브릿지 데이터) → `td()`가 앱 데이터 우선, 없으면 Twelve Data MCP. `callRaw` 큐/재시도. Twelve Data 한도 분당 8 크레딧 → 분석 탭 `stg()`로 호출 시차. 통계만 `APPQ.fundStats` 폴백, 목표가·회사정보·실적·뉴스는 Twelve Data 의존.
- **분석 탭 계산**: `tech()`(SMA/EMA/MACD/RSI/볼린저/ATR/ADX/스토캐스틱/OBV/스윙/52주/MDD/변동성) → `techSignals`(11개, 가중 추세3·MACD2·RSI1.5·6개월1.5…) + `fundSignals`(밸류2·수익성1.5·성장2·건전성1·애널리스트1.5·서프라이즈1) → 총점 = 0.55×기술 + 0.45×펀더멘털 → `verdict`(≥70 매력적, ≥58 관심, ≥45 중립, ≥35 주의, 그 외 회피). `scenarios`: 63일 시계, 변동성 기반 가격, 확률 = 0.30±0.15×tilt (공식).
- **Claude 호출(`sample`)**: 분석 탭 AI 버튼(수동), 차트 이미지 분석(`askClaude`, 7섹션), 매크로×종목(`mb-apply`).
- **프로 차트**: 앱 차트 엔진 이식(약 3.5k줄).
- **스케줄 작업**(Claude Code 원격 루틴):
  - 06:17 화~토 — 스냅샷 갱신
  - 매시 :13 — 대기 중 스크리너 처리(웹 검색)
  - 07:03, 14:45(베를린) — 알림 스캔(푸시)
  - 07:35, 15:05 — 분석 파일 생성(푸시/메일 끔)

## 3. 분석 파일 파이프라인
```
bridge/scripts(DB) → features.py (Drive 시세로 지표·점수)
→ ev.json 갱신 (WebSearch/WebFetch, 회당 ≤25종목: 실적일·이벤트)
→ insight.py (규칙 verdict + 주간 검증) → build_analysis.py (analysis@1 + contentKey)
→ Drive create_file (타임스탬프 새 파일) → bridge/state 갱신
```
- Drive 커넥터는 신규 생성만 가능(덮어쓰기 불가) → 파일 누적.
- **규칙 점수(`features.py score`)**: 200일선 ±2, 50일선 ±1, 3개월 수익률>0 +1, RSI≥75 −2/≥70 −1/≤30(200일선 위) +1, 20일선 이격≤−4%(200일선 위) +2, 0<PEG<1.5 +1, PER>45 −1, 컨센서스 매수 +1/매도 −1. 지지/매수/손절/목표: support=max(SMA20/50/200, 20·60일 저점 중 현재가×0.995 아래), buy=support×1.01, stop=support−1.5×ATR, sell=min(52주 고점, 현재가×1.15).
- **verdict(`insight.py`)**: 점수≤−2 sell; ≥4 & RSI<70이면 (실적 0~3일 내 hold) / (≥5 & 지지까지 ≤4% buy) / 그 외 hold('추격 보류'). 
- **주간 검증**: buy는 변화>0 적중, sell은 변화<0 적중, hold는 |변화|<4% 적중. 벤치마크·손절/목표 도달 미반영.
- Claude가 실제로 넣는 것: 실적일, "why" 문장, 매크로 한 줄.

## 4. 스키마
- `claude-bridge/quotes@1`: name, price, prev, chgPct, asOf, currency, 관심종목 항목.
- `claude-bridge/quotes-detail@1`: closes(63), ohlcv(130; 관심종목·기술·펀더멘털·섹터 400). v1.76.0부터 선택 필드 `rule`: `{cv:규칙버전, v:buy|hold|avoid, r:이유코드, sc:점수, p:[[항목id,점수]…], lv:{support,buy,stop,sell}|null, f:[플래그], m:[결측 입력], d:실적까지 일수|null, pb:눌림목 처리|null}` (보유·수량·메모는 포함하지 않음).
- `claude-bridge/analysis@1`: macro, screens, pullbacks, alerts (모두 선택), contentKey, generatedAt.
  - `alerts.results[]`의 선택 필드 `opinion:{stance:agree|counter|hold, why}` (v1.79.0~): 앱 규칙 신호에 대한 Claude 의견. 판정(`verdict`)은 바꾸지 않고 앱 'Claude 분석' 탭에 칩으로만 표시. 빌더(`build_analysis.py`)는 필드를 그대로 통과시킨다.
- 스키마 변경 시 앱 CLAUDE.md와 데스크 양쪽을 함께 갱신한다.

## 5. 점수 체계 현황 (핵심 문제)
| # | 위치 | 방식 |
|---|---|---|
| ① | 앱 `scoreOf` | 퀄리티·밸류·모멘텀 (스크리너) |
| ② | 데스크 분석 탭 | 지표 11 + 펀더 6 가중평균 → 5단계 |
| ③ | 스케줄 Python | 정수 가점제 → buy/hold/sell, 앱에 "Claude 판정"으로 표시 |

## 6. 장단점 요약
**장점**: 브릿지 방향 분리·버전화·선택 필드, 앱 쪽 방어(이스케이프·같은 id 덮어쓰기·최소 스코프), 앱 데이터 우선·일봉 재활용, 앱 폴백 체인, 데스크 무인 자동화, 차트 이미지·매크로 해석·웹 스크리너는 Claude 고유.
**단점**: 판정 3중화·라벨 혼동 / 데스크의 지표·차트·저널 중복 / Twelve Data 잔여 의존 / 앱 Gemini 얕음(템플릿+무그라운딩) / 메모·수량 등 불필요한 개인정보 내보내기 / 분석 파일 누적·무음 실패 / 적중 검증 부재(`taSignalBacktest` 미연결) / 시나리오 확률 오해 소지.

## 추가 (2026-10-30)
- `quotes-detail@1`의 `fund.ext`(선택, 관심·분석 종목만): `{ts, fwdPe, pe, peg, pm, om, roe, rg, eg, de, cr, tAvg, tMin, tMax, sector, industry}`. 비율은 % 단위, `de`는 Yahoo 방식(150=150%). 데스크가 Twelve Data 통계·목표가 대신 사용.
- 판정 기록 `insight/hist-YYYYMMDD.items[sym]`: `{v,p,sc,at,b,lv}` — `b`=기록 시점 SPY 가격, `lv`={buy,stop,sell}. 주간 복기가 SPY 대비 초과수익과 가격대 도달에 쓴다.

### 상태 파일 `claude_status.json` (`claude-bridge/status@1`)
- 위치: 브릿지 폴더. 스케줄이 매 실행 끝에 덮어쓴다(없으면 생성, 정리 대상 아님). 필드: `lastCheckAt`(ISO UTC), `result`(한 줄, 200자 이내).
- 앱: `fetchLatestAnalysis`가 함께 읽어 `ST.status`로 보관, `statusNote()`가 표시. `schedStale`이 Berlin 시간 기준 평일 30시간·주말/월요일 08시 전 80시간 초과 시 경고.

## 전망 엔진 · 예측 아레나 (2026-11-13, 앱 v1.86.0)
**전망 엔진 `mod-forecast`**: `window.Forecast` — 순수 함수(`run`/`regime`/`scoreCall`), 임계값은 `CFG` 한 곳. 입력은 일봉뿐(5년).
- 변동성: 일간 로그수익률 EWMA 분산을 장기 분산 쪽으로 되돌려 h일 변동성을 만든다.
- 분포: 과거 h일 수익률을 그때의 예상 변동성으로 나눈 표준화 잔차의 경험 분포(정규 가정 없음)를 지금 변동성으로 키운다.
- 중심: 과거 평균을 그대로 잇지 않는다. 시장 장기 평균과 종목 평균(상·하한)을 반반 + 유사 국면 기울기 × `w`.
- 유사 국면(k-최근접): 200·50일선 이격, 63·21일 수익률, RSI, 변동성 비율, 1년 고점 대비 낙폭이 가장 가까운 과거 날들.
- 워크포워드 검증(각 시점은 그날까지의 데이터만 사용): 50%·80% 구간 적중률, 방향 Brier 점수를 '과거 상승 비율' 기준선과 비교. 구간이 좁았으면 폭을 넓힌다(`kappa`). `w` 는 유사 국면이 실제로 도움이 된 만큼만(0~1) — 도움이 안 됐으면 0 이라 방향 확률은 기준선에 머문다.
- 결과: 기간(5·21·63거래일)별 분위수·가격, 상승 확률, 검증 수치, 콘(부채꼴), 국면(추세 × 변동성 + 같은 국면의 과거 성적).
- 테스트: `node tools/test-forecast.mjs` (미래 참조 없음, 무작위 걸음에서 예측력 없음, 추세 지속형에서 기준선 초과, 구간 적중률, 결정론).
- 한계: 가격·거래량 외 정보 없음. 종목 하나의 몇 년이라 표본이 작다. 실제 시세로 한 대규모 검증은 아직 없다(KNOWN_GAPS).

**표시 `mod-forecast-ui`**: 종목 분석 탭 '확률 전망' 카드(`forecastRender`). 방향 예측력이 확인되지 않으면 그렇게 적고 범위를 앞세운다. 시장 국면은 SPY 5년 일봉으로 같은 함수(`Forecast.regime`)를 돌린다. `forecastFor(sym)` 은 아레나용.

**예측 아레나 `mod-game`**: `window.GAME`, 탭 `arena`(모의투자 허브), 저장 `pentanalyst_game_v1`.
- 예측: 종목·기간(5/21거래일)·방향·확신도를 잠그면 그 순간의 엔진 확률·기준선도 함께 저장, h거래일 뒤 종가로 채점(Brier → 0~100점). 수정·삭제 없음.
- 성적표: 나 / 전망 엔진 / 기준선 / 동전 — 엔진의 실전(표본 외) 성적 기록을 겸한다.
- 경험치: 지급 내역(`grants`, 키 `날짜|종류|id`)의 합. 접속·일일 퀘스트 3개·예측·배지에만 준다(매매 횟수·수익에는 주지 않음). 100일 넘은 내역은 달별 합계(`arch`)로 접는다.
- 동기화: `GSYNC` `MERGERS.pentanalyst_game_v1` 이 지급 내역·예측·배지를 항목 단위로 합친다.
- 이벤트: `switchAppTab`·`executeAnalysis`·전망 카드가 `GAME.emit` 을 부른다.

**화면 스킨(NX)**: 메인 `<style>` 끝의 `NX 스킨` 블록. 색 규칙은 어두운 테마에만, `.nx-*` 부품은 공통(밝은 테마 덮어쓰기 포함).
