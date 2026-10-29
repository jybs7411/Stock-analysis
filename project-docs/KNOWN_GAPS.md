# 아직 확인하지 못한 부분

문서의 주장은 아래를 제외한 영역에서만 코드로 확인되었다. 확인하면 이 목록에서 지우고 ARCHITECTURE에 반영한다.

**데스크 (아티팩트)**
- 분석 탭 일부 렌더링, 시장 탭, 저널 탭, 우측 레일, 스크리너 결과 렌더링, 프로 차트 엔진 내부
- 저널이 앱의 장부/불단왕 일지와 얼마나 겹치는지

**앱**
- `mod-watch` 알림 엔진, `mod-revision`, `fetchDeep`/`fetchFundamentals` 상세, GSYNC 병합 세부, 불단왕 엔진 세부, `mod-sim`/`mod-exit`/`mod-risk`
- Worker의 stale 캐시(`X-Cache: STALE`)를 UI가 사용자에게 표시하는지
- Worker 데이터가 Twelve Data 대체에 충분한지 (R-4 선행 조사)
- 앱 Gemini 13개 호출 지점의 실제 사용 빈도

**스케줄/브릿지**
- 스케줄 작업 실패 시 알림 경로 (현재 푸시/메일 꺼짐)
- 분석 파일 누적량과 폴더 검색 비용
