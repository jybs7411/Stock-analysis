# PentAnalyst 자체 프록시 (Cloudflare Worker)

브라우저에서 Yahoo Finance를 직접 호출하면 CORS로 막힙니다. 이 Worker가 대신 호출해 주고,
`index.html`은 이 주소만 호출합니다. 무료 플랜(하루 10만 요청)으로 충분합니다.

## 제공 API

| 경로 | 설명 |
| --- | --- |
| `GET /api/health` | 동작 확인 |
| `GET /api/chart?symbol=NVDA&range=1y` | Yahoo 일봉 차트 JSON (1분 캐시). 없는 티커는 404 |
| `GET /api/deep?symbol=NVDA` | 심층 분석용: 실적(EPS 서프라이즈·전망·다음 발표일), 재무(성장률·마진·부채·FCF·연/분기 매출), 애널리스트(의견 분포·상향/하향), 수급(기관·내부자 보유·거래), 배당, 최신 뉴스 (1시간 캐시) |
| `GET /api/fundamentals?symbol=NVDA` | P/E, Forward P/E, PEG, P/S, P/B, ROE, Short Float, 애널리스트 목표가(평균/최저/최고), 컨센서스, 섹터·업종, 사업 개요 + 스크리너 필터용 값: 베타, 배당(수익률·배당금·배당성향), ROA, 매출총이익률·영업이익률·순이익률, 매출/이익 성장률, 부채비율(%), 유동·당좌비율, FCF, 총매출, 애널리스트 평균 점수·수, 내부자/기관 보유율, 유통주식수, 평균 거래량, 국가·거래소·통화, EPS(실적/예상). 값이 없으면 `null`, 비율은 12.3 = 12.3% (6시간 캐시, 추가 업스트림 요청 없음) |

## 배포 (5분)

```bash
cd worker
npm install -g wrangler        # 또는 npx wrangler ...
wrangler login                 # 브라우저로 Cloudflare 로그인 (무료 계정)
wrangler deploy                # 배포 완료 시 https://pentanalyst-proxy.<계정>.workers.dev 출력
curl https://pentanalyst-proxy.<계정>.workers.dev/api/health
```

## 프론트엔드 연결

1. `index.html`을 열고 우측 상단 **API 키 & 구글 검색 설정**을 클릭
2. **자체 프록시 주소**에 위 Worker URL 입력 → **설정 저장**
   (`index.html`의 `DEFAULT_PROXY_URL` 상수에 고정해 둘 수도 있습니다)

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
