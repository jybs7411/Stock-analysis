# PentAnalyst 자체 프록시 (Cloudflare Worker)

브라우저에서 Yahoo Finance를 직접 호출하면 CORS로 막힙니다. 이 Worker가 대신 호출해 주고,
`index.html`은 이 주소만 호출합니다. 무료 플랜(하루 10만 요청)으로 충분합니다.

## 제공 API

| 경로 | 설명 |
| --- | --- |
| `GET /api/health` | 동작 확인 |
| `GET /api/chart?symbol=NVDA&range=1y&interval=1d` | Yahoo 차트 JSON (1분 캐시). `interval`은 `1m`~`90m`(분봉, 1m은 최근 7일·나머지 약 60일)·`1d`·`1wk`·`1mo`, `range`는 `1mo`~`10y`·`max`. 없는 티커는 404 |
| `GET /api/spark?symbols=SPY,QQQ&range=3mo&interval=1d` | 여러 종목(최대 120)의 종가 시계열을 한 번에. `{심볼:{t,c,prev,price,currency}}` (1분 캐시) |
| `GET /api/quotes?symbols=AAPL,MSFT` | 여러 종목(최대 60)의 현재가·등락률·시가총액·52주 고저 등 (30초 캐시) |
| `GET /api/search?q=basf` | 회사명·티커 검색 (전 세계 거래소, 주식·ETF·지수·코인). `[{symbol, name, exchange, type}]` (1시간 캐시) |
| `GET /api/deep?symbol=NVDA` | 심층 분석용: 실적(EPS 서프라이즈·전망·다음 발표일), 재무(성장률·마진·부채·FCF·연/분기 매출), 애널리스트(의견 분포·상향/하향), 수급(기관·내부자 보유·거래), 배당, 최신 뉴스 (1시간 캐시) |
| `GET /api/fundamentals?symbol=NVDA` | P/E, Forward P/E, PEG, P/S, P/B, ROE, Short Float, 애널리스트 목표가(평균/최저/최고), 컨센서스, 섹터·업종, 사업 개요 + 스크리너 필터용 값: 베타, 배당(수익률·배당금·배당성향), ROA, 매출총이익률·영업이익률·순이익률, 매출/이익 성장률, 부채비율(%), 유동·당좌비율, FCF, 총매출, 애널리스트 평균 점수·수, 내부자/기관 보유율, 유통주식수, 평균 거래량, 국가·거래소·통화, EPS(실적/예상). 값이 없으면 `null`, 비율은 12.3 = 12.3% (6시간 캐시, 추가 업스트림 요청 없음) |
| `GET /api/fred?ids=DGS10,DGS2,T10Y2Y,BAMLH0A0HYM2` | **(키 불필요)** FRED 공식 시리즈(국채금리·장단기 금리차·하이일드/회사채 스프레드·실질금리·기대인플레이션·금융 스트레스·연방기금금리·CPI·근원 PCE·실업률·실업수당 청구 등 허용 목록만). 마지막 값·전일/5일/21일 변화·1년 백분위·최근 120개 (1시간 캐시) |
| `GET /api/feargreed` | **(키 불필요)** CNN 공포·탐욕 지수와 최근 30일 추이. 비공식 경로라 막히면 502 (30분 캐시) |
| `GET /api/finnhub?kind=reco\|insider\|peers\|surprise&symbol=AAPL` · `?kind=news` | **(Finnhub 키 필요)** 애널리스트 투자의견 추이 / 내부자 매수 심리(MSPR) / 동종 종목 / EPS 서프라이즈 / 시장 헤드라인(15분 캐시). 키가 없으면 501 |

### 야후 장애 시 자동 백업
- `/api/chart`·`/api/spark` : 야후가 실패하면 **Stooq 일/주/월봉**으로 대체 (응답 헤더 `X-Source: stooq`). 분봉·선물·환율·VIX는 대체하지 않음.
- `/api/quotes` : 야후가 실패하면 **Finnhub 시세(키 있을 때) → Stooq 최근 2개 일봉**으로 대체 (`degraded: true`, 시총·52주 등은 비어 있음).
- `/api/calendar` : 야후가 실패하면 Finnhub 로 **실적·IPO** 만 대체 (키 있을 때).

### FRED 키 등록 (선택, 무료)
키가 없어도 공개 CSV 로 동작하지만, 키를 등록하면 공식 API 를 먼저 쓰고 실패 시 CSV 로 되돌아갑니다(더 안정적).
```bash
# 저장소 루트에서 (배포 Worker 이름: stock-analysis)
npx wrangler secret put FRED_KEY --name stock-analysis
```
(또는 Cloudflare 대시보드 → Workers & Pages → `stock-analysis` → Settings → Variables and Secrets → Secret 추가)

### Finnhub 키 등록 (선택, 무료)
```bash
# 저장소 루트에서 (배포 Worker 이름: stock-analysis)
npx wrangler secret put FINNHUB_KEY --name stock-analysis   # finnhub.io 에서 무료 발급한 키를 붙여 넣기
```
(또는 대시보드 → `stock-analysis` → Settings → Variables and Secrets)
Secret 은 코드 재배포 없이도 바로 적용됩니다. 단, 이 Worker 코드(`worker/index.js`)가 최신 버전으로 배포돼 있어야 합니다.
키가 없어도 모든 기능은 기존처럼 동작하고 Finnhub 보강만 건너뜁니다. 키는 Worker 에만 저장되어 브라우저에 노출되지 않습니다.

## 배포

화면(`docs/`)과 이 프록시가 **하나의 Worker `stock-analysis`** 로 함께 배포됩니다(저장소 루트 `wrangler.jsonc`).
Cloudflare 에서 이 저장소를 Git 연결해 두었다면 `main` 에 푸시할 때마다 자동 배포됩니다. 수동 배포는 **저장소 루트**에서:

```bash
npx wrangler deploy            # worker/ 폴더가 아니라 루트에서 실행
curl https://stock-analysis.<계정>.workers.dev/api/health
```

> `worker/wrangler.toml`(이름 `pentanalyst-proxy`)은 예전 별도 프록시용 설정으로, 지금은 쓰지 않습니다.

## 프론트엔드 연결

화면과 API 가 같은 `*.workers.dev` 주소이므로 별도 입력이 필요 없습니다(같은 주소의 `/api` 를 자동 사용).
`index.html` 을 파일로 직접 열 때만 **API 키 & 구글 검색 설정 → 자체 프록시 주소**에 `https://stock-analysis.<계정>.workers.dev` 를 입력하세요.

## 보안

- `wrangler.toml`의 `ALLOWED_ORIGIN`을 프론트엔드 도메인으로 바꾸면 다른 사이트에서 가져다 쓰지 못합니다.
  (`index.html`을 파일(`file://`)로 열 때는 Origin이 `null`이라 `"*"`로 두어야 합니다.)
- 심볼은 `^[A-Z0-9.\-^=]{1,15}$` 만 허용하며, 지정한 Yahoo 경로만 호출합니다 (오픈 프록시가 아닙니다).

## 참고 / 한계

- `/api/deep`은 Yahoo의 여러 모듈을 한 번에 요청합니다. 종목에 따라 일부 항목(재무제표 계열 등)이 비어 있을 수 있고, 비어 있는 항목은 화면에 표시되지 않습니다.
- Worker 코드를 수정한 뒤에는 Cloudflare 대시보드에서 코드를 다시 붙여 넣고 **Deploy**(또는 `wrangler deploy`)해야 반영됩니다.
- **스마트 스크리너의 재무 필터(ROA·마진·성장률·부채비율·배당·베타·보유율 등)를 쓰려면 Worker를 최신 코드로 다시 배포해야 합니다.** 예전 Worker가 배포돼 있으면 이 값들이 비어 있고, 해당 필터는 값이 있는 종목에만 적용됩니다. (캐시가 6시간이라 재배포 직후엔 이전 응답이 남아 있을 수 있습니다.)

- Yahoo Finance 비공식 엔드포인트라 정책이 바뀌면 동작이 달라질 수 있습니다. 재무 지표(`/api/fundamentals`)는
  쿠키·crumb 인증이 필요해서 Worker가 자동으로 처리하며, 실패 시 한 번 재시도합니다.
- 일부 값(PEG 등)은 Yahoo가 제공하지 않으면 `null`이고, 화면에는 `N/A`로 표시됩니다.
- 개인 학습·참고용입니다. 투자 판단의 근거로 사용하지 마세요.
