# aws/ — 클라우드 마이그레이션 (프로젝트 3 온프레미스 → 프로젝트 5 AWS)

설계 보고서(`프로젝트5_보고서_골격.pdf`)에 따라 온프레미스 스마트 수면 조명 서비스를
AWS 서버리스 구조로 옮기는 **AWS SAM** 프로젝트입니다. 4-Layer 를 레이어별 독립 스택으로 분리하고,
각 스택은 **Storage 스택의 Export 를 Import** 합니다.

## 디렉터리

```
aws/
├── template.yaml                 ★ Storage+Foundation 스택 (이준혁) — DynamoDB 10개 테이블
├── layers/processing.yaml        ★ Processing+API 스택 (임형택) — Lambda·API GW·EventBridge
├── layers/ingestion.yaml         ★ Ingestion 스택 (정일혁) — IoT Rule 2개·IAM·CloudWatch
├── layers/frontend.yaml          ★ Frontend 스택 (노원우) — S3+CloudFront·OAC·보안헤더·HTTPS
├── src/processing/               ★ Lambda 소스 (임형택)
├── src/ingestion/                ★ 엣지 노드 + 디바이스 프로비저닝 (정일혁) — README 참조
├── samconfig.toml                  Storage SAM 배포 설정
├── samconfig-processing.toml       Processing SAM 배포 설정
├── samconfig-ingestion.toml        Ingestion SAM 배포 설정
├── samconfig-frontend.toml         Frontend SAM 배포 설정
├── HANDOVER-cloud.md               통합 인수인계서 (배포 순서·의존성·소유권) ← 먼저 읽기
├── migration/
│   ├── sqlite-to-dynamodb.js     ★ SQLite → DynamoDB 이전 (이준혁)
│   ├── package.json · README.md
└── docs/
    ├── 01-architecture.md        ★ §1 4-Layer 아키텍처 (이준혁)
    ├── 04-dynamodb-design.md     ★ §4 DynamoDB 설계 (이준혁)
    ├── 06-cost-estimate.md       ★ §6 비용 추정 (이준혁)
    ├── spec-ingestion-iot.md       ★ 정일혁 명세+구현 (§2.1, §6)
    ├── spec-processing-lambda.md   ★ 임형택 명세+구현 (§2.2, §3, §5.1, §6)
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

## 빠른 시작 (임형택 파트)

```bash
# 1) Storage 스택 선행 배포 후
cd aws
sam build -t layers/processing.yaml
sam deploy --config-file samconfig-processing.toml --config-env processing \
  --parameter-overrides FitbitClientId=<id> FitbitClientSecret=<secret> IotDataEndpoint=<ats-endpoint>

# 2) Fitbit 토큰 Secrets 이전 (sleep.db 보유 시)
cd migration
node sqlite-to-secrets.js --db ../../backend/data/sleep.db --dry-run
node sqlite-to-secrets.js --db ../../backend/data/sleep.db
```

## 빠른 시작 (정일혁 파트 — Ingestion)

```bash
# 1) Storage 스택 선행 배포 후 — 디바이스 프로비저닝 (Thing/정책/인증서)
cd aws/src/ingestion/provisioning
./provision.sh                 # 멱등: 재실행해도 고아 인증서 안 쌓임

# 2) IoT Rules + 모니터링 배포 (조도→DynamoDB, 상태→CloudWatch[+Lambda])
cd ../../../                   # aws/
sam deploy --config-file samconfig-ingestion.toml --config-env ingestion
#   Rule B 를 임형택 DeviceStatus Lambda 로 연동 시 DeviceStatusFnArn 오버라이드

# 3) 엣지 실행 (라즈베리파이 또는 PC dry-run)
cd src/ingestion/edge && npm install
MOCK_IOT=true MOCK_SENSOR=true npm start   # 인증서 없는 PC: dry-run 검증
```
상세: **[src/ingestion/README.md](src/ingestion/README.md)**

## 빠른 시작 (노원우 파트 — Frontend)

```bash
# (0) 선행: Processing 스택 배포 후 ApiUrl 확인 (분리 도메인 방식)
aws cloudformation list-exports \
  --query "Exports[?Name=='smartsleep-processing-ApiUrl'].Value" --output text

# (1) 호스팅 스택 배포 (S3 비공개 + CloudFront OAC)
cd aws
sam validate --lint -t layers/frontend.yaml
sam deploy --config-file samconfig-frontend.toml --config-env frontend
#   → Output: SiteBucketName / DistributionId / SiteUrl

# (2) 빌드 + 업로드 + 무효화 (평소엔 .github/workflows/frontend-deploy.yml 이 자동화)
cd ../frontend
VITE_API_BASE_URL=<ApiUrl> npm run build
aws s3 sync dist s3://<SiteBucketName> --delete \
  --cache-control "public,max-age=31536000,immutable" --exclude index.html
aws s3 cp dist/index.html s3://<SiteBucketName>/index.html \
  --cache-control "no-cache,must-revalidate"
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths /index.html
```
상세: **[docs/spec-frontend-hosting.md](docs/spec-frontend-hosting.md)**

자세한 의존성·교차 참조·보고서와 코드 차이는 **[HANDOVER-cloud.md](HANDOVER-cloud.md)** 참조.

## 전제
- AWS CLI + SAM CLI 설치, 자격증명 구성(`aws configure` / SSO).
- 리전 `ap-northeast-2`, `ProjectName=smartsleep`, `Environment=dev` (변경 시 모든 레이어 동기).
- 온프레미스 코드(루트 엣지노드, `backend/`, `frontend/`)는 참조용으로 유지 — 본 디렉터리가 클라우드 산출물.
