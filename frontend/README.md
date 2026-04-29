# Frontend — Smart Sleep Lighting Dashboard

RPi 온프레미스 환경에서 동작하는 단일 사용자 수면/조명 대시보드입니다.

## 기술 스택

- **Vite + React** — 빌드/번들러
- **React Router** — SPA 라우팅
- **TanStack Query** — 서버 상태/캐싱/폴링
- **Recharts** — 차트 (수면 단계, 조도 그래프)
- **Tailwind CSS v4** — 스타일링 (다크 테마)

## 폴더 구조

```
src/
├── api/          백엔드 REST 호출 (도메인별 1:1 매핑)
├── hooks/        React Query 기반 데이터 훅
├── components/   재사용 UI 조각 (Card, Stat, QueryState, ...)
├── pages/        라우트별 페이지 (Dashboard, History, Illuminance, Settings)
├── layout/       공통 레이아웃 (AppLayout)
└── lib/          포맷팅 등 유틸
```

데이터 의존성은 항상 `pages → hooks → api → fetch` 한 방향으로 흐릅니다.
컴포넌트가 직접 fetch하지 않게 유지하면 백엔드 API가 바뀔 때 영향 범위가
`api/` 폴더 안으로 한정됩니다.

## 개발 시작

```bash
npm install
cp .env.example .env.local   # 필요 시 백엔드 주소 수정
npm run dev
```

기본적으로 `http://localhost:5173` 에서 열립니다.

> 백엔드가 비어있어 화면이 비어 보일 땐 `backend/`에서 `npm run seed`를 실행하면
> 14일치 가짜 수면/조도 데이터가 들어갑니다 (`backend/scripts/seed-dev-data.js`).

## 검증

```bash
npm run lint    # ESLint
npm run build   # 프로덕션 빌드 (dist/)
npm run preview # 빌드 산출물 로컬 미리보기
```

## 환경변수

| 키 | 기본값 | 설명 |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:3001` | 백엔드 REST API 주소 |

## 백엔드 연동 엔드포인트

`backend/server/index.js` 기준:

- `GET  /api/health`
- `GET  /api/reports?date=YYYY-MM-DD`
- `GET  /api/reports/recent?days=7`
- `GET  /api/illuminance/current`
- `GET  /api/illuminance/history?hours=24`
- `GET  /api/schedule` · `POST /api/schedule` · `DELETE /api/schedule`
- `GET  /api/fitbit/status`
- `GET  /api/device/status`
- `POST /api/lighting/routine`

각 엔드포인트는 `src/api/*.js`의 동명 모듈에서 호출합니다.

## 페이지 구성 (MVP)

| 라우트 | 화면 | 주요 데이터 |
|---|---|---|
| `/` | 대시보드 — 오늘 요약 | reports.recent, illuminance.current |
| `/history` | 수면 히스토리 | reports.recent(30) |
| `/illuminance` | 조도 모니터링 | illuminance.current + history |
| `/settings` | 스케줄/연동 상태 | schedule, fitbit.status |

## 빌드 / 배포

```bash
npm run build
# dist/ 결과물을 RPi의 nginx 또는 Express static으로 서빙
```
