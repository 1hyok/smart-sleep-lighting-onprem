# aws/ — 클라우드 마이그레이션 (프로젝트 3 온프레미스 → 프로젝트 5 AWS)

설계 보고서(`프로젝트5_보고서_골격.pdf`)에 따라 온프레미스 스마트 수면 조명 서비스를
AWS 서버리스 구조로 옮기는 **AWS SAM** 프로젝트입니다. 4-Layer 를 레이어별 독립 스택으로 분리하고,
각 스택은 **Storage 스택의 Export 를 Import** 합니다.

## 디렉터리

```
aws/
├── template.yaml                 ★ Storage+Foundation 스택 (이준혁) — DynamoDB 10개 테이블
├── samconfig.toml                  SAM 배포 설정 (region=ap-northeast-2)
├── HANDOVER-cloud.md               통합 인수인계서 (배포 순서·의존성·소유권) ← 먼저 읽기
├── migration/
│   ├── sqlite-to-dynamodb.js     ★ SQLite → DynamoDB 이전 (이준혁)
│   ├── package.json · README.md
└── docs/
    ├── 01-architecture.md        ★ §1 4-Layer 아키텍처 (이준혁)
    ├── 04-dynamodb-design.md     ★ §4 DynamoDB 설계 (이준혁)
    ├── 06-cost-estimate.md       ★ §6 비용 추정 (이준혁)
    ├── spec-ingestion-iot.md       📋 정일혁 명세 (§2.1, §6)
    ├── spec-processing-lambda.md   📋 임형택 명세 (§2.2, §3, §5.1, §6)
    └── spec-frontend-hosting.md    📋 노원우 명세 (§5.2, §6)
```
★ = 이준혁(본인) 구현 완료 · 📋 = 타 담당자 인수인계 명세

## 빠른 시작 (이준혁 파트)

```bash
# 1) Storage 스택 배포 (DynamoDB 10개 테이블 생성)
cd aws
sam validate --lint
sam build
sam deploy                     # samconfig.toml 의 smartsleep-storage / ap-northeast-2 사용

# 2) 기존 SQLite 데이터 이전 (sleep.db 가 있는 머신에서)
cd migration
npm install
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db --dry-run   # 미리보기
node sqlite-to-dynamodb.js --db ../../backend/data/sleep.db             # 실제 적재
```

## 배포 순서

1. **Storage (이준혁)** — 모두가 Import 하는 데이터 평면. 항상 선행.
2. **Ingestion (정일혁) / Processing (임형택)** — 병렬. Storage Export 를 Import.
3. **Frontend (노원우)** — Processing 의 API 도메인으로 빌드/배포.

자세한 의존성·교차 참조·보고서와 코드 차이는 **[HANDOVER-cloud.md](HANDOVER-cloud.md)** 참조.

## 전제
- AWS CLI + SAM CLI 설치, 자격증명 구성(`aws configure` / SSO).
- 리전 `ap-northeast-2`, `ProjectName=smartsleep`, `Environment=dev` (변경 시 모든 레이어 동기).
- 온프레미스 코드(루트 엣지노드, `backend/`, `frontend/`)는 참조용으로 유지 — 본 디렉터리가 클라우드 산출물.
