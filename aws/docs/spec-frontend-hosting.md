# 인수인계 명세 — Service-Frontend Layer (담당: 노원우)

> 보고서 §5.2(S3+CloudFront 호스팅, OAC, 환경변수 주입, CORS, 캐시, 보안헤더), §6(CloudFront 통신보안) 구현 명세.
> 작성: 이준혁. 산출물: `aws/layers/frontend.yaml`(신규 SAM/CFN 스택) + `frontend/.env.production` + CI 배포.

---

## 0. 현재 프론트엔드 실측 (변경 영향 큰 부분 ★)

| 항목 | 실제 값 | 마이그레이션 영향 |
|---|---|---|
| 프레임워크 | React 19 + Vite, react-router-dom v7(**BrowserRouter**) | ★ SPA 딥링크 → 403/404 fallback 필요 |
| HTTP 클라이언트 | **`fetch` 래퍼**(`src/api/client.js`). **axios 아님** | ★ 보고서 §5.2.3 의 axios 예시는 부정확 |
| Base URL | `import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001"` | ★ **빌드타임** 주입 env |
| 자격증명 | `fetch` 에 `credentials` 미설정, Authorization 헤더 없음 | ★ 보고서 §5.2.6 의 HttpOnly 쿠키+withCredentials 와 불일치 |
| 빌드 출력 | `dist/` (override 없음), `base: '/'` | 루트 호스팅 전제 |
| Dev 서버 | `host:true`(0.0.0.0), port **5173** | CORS allowlist 에 `http://localhost:5173` |
| 데이터 패칭 | `@tanstack/react-query` 폴링(5s~60s), `recharts` 차트 | 순수 클라 라이브러리, 영향 없음 |
| 호출 경로 | 전부 `/api/...` prefix(11개) | ★ 단일 CloudFront behavior 로 묶기 좋음 |

> ★ **보고서 ↔ 코드 차이 2건**(노원우 확인 필요):
> 1. 보고서 §5.2.3 은 `axios.create({withCredentials:true})` — 실제는 axios 없음, `fetch` 사용. 인증 헤더/쿠키 미전송.
> 2. 보고서 §5.2.6 은 HttpOnly Cookie + `withCredentials:true`. 실제 클라는 쿠키/토큰 미전송 → 인증 도입 시
>    `client.js request()` 에 토큰 헤더 추가(또는 `credentials:'include'`) + 백엔드(임형택) CORS 동기 변경 필요.

---

## 1. 호스팅 아키텍처 (보고서 §5.2.1)

`dist/`(순수 정적 자산) → **S3(origin, 비공개) + CloudFront(CDN)**. EC2+Nginx 대비 비용·운영·지연 우위.
이점: 서버리스(인스턴스 관리 불필요), 엣지 캐싱 저지연, ACM 무료 HTTPS, HTTP/2·Brotli·IPv6 자동.

### 권장: API 도 같은 CloudFront 뒤로 (CORS 제거)
모든 호출이 `/api/*` prefix 이므로 **2번째 origin/behavior** 로 API Gateway 를 붙이면 **동일 출처**가 되어
preflight/CORS 가 사라진다. 분리 도메인(별 도메인)으로 둘 경우엔 §4 CORS 설정 필수.

```
CloudFront distribution
 ├─ behavior "/*"     → S3(OAC)            : SPA 정적 자산
 └─ behavior "/api/*" → API Gateway(임형택): REST  ← 권장(동일 출처, CORS 불필요)
```

---

## 2. S3 보안 — OAC (보고서 §5.2.2)

- S3 **Public Access Block 전부 활성**(완전 비공개).
- CloudFront **OAC** 생성 → 해당 배포만 SigV4 서명으로 S3 접근.
- 버킷 정책: `Principal: cloudfront.amazonaws.com` + `Condition: AWS:SourceArn = <배포 ARN>`(타 배포 차단).
- OAI 대신 OAC: 전 리전/SigV4, SSE-KMS 객체 접근, 동적 메서드 확장 우위.

```yaml
# aws/layers/frontend.yaml (발췌)
SiteBucket:
  Type: AWS::S3::Bucket
  Properties:
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }
OAC:
  Type: AWS::CloudFront::OriginAccessControl
  Properties:
    OriginAccessControlConfig: { Name: smartsleep-oac, OriginAccessControlOriginType: s3, SigningBehavior: always, SigningProtocol: sigv4 }
SiteBucketPolicy:
  Type: AWS::S3::BucketPolicy
  Properties:
    Bucket: !Ref SiteBucket
    PolicyDocument:
      Statement:
        - Effect: Allow
          Principal: { Service: cloudfront.amazonaws.com }
          Action: s3:GetObject
          Resource: !Sub '${SiteBucket.Arn}/*'
          Condition: { StringEquals: { 'AWS:SourceArn': !Sub 'arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}' } }
```

### SPA 라우팅 fallback (BrowserRouter 필수)
CloudFront **Custom Error Responses**: 403·404 → `/index.html`, **응답코드 200**. (또는 CloudFront Function rewrite.)
```yaml
CustomErrorResponses:
  - { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: /index.html, ErrorCachingMinTTL: 0 }
  - { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: /index.html, ErrorCachingMinTTL: 0 }
```

---

## 3. API Base URL 주입 (보고서 §5.2.3 — 코드 맞춤 수정)

Vite 빌드타임 치환. **env 이름 = `VITE_API_BASE_URL`**(보고서의 일반 axios 예시 대신 실제 `fetch` 래퍼가 읽는 값).
```bash
# frontend/.env.production
VITE_API_BASE_URL=https://<cloudfront-domain>          # 같은 배포 /api/* 권장 → 동일 출처
# 또는 분리 도메인: https://<api-id>.execute-api.ap-northeast-2.amazonaws.com/prod
```
```js
// 현재 src/api/client.js (그대로 동작 — 코드 수정 불요)
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";
```
- ⚠️ env 미설정 시 **`http://localhost:3001` fallback** 이 그대로 번들에 박힌다 → **CI 에서 prod 빌드 전 반드시 설정**.
- 빌드타임 치환이라 환경별 재빌드 필요. 재빌드 회피하려면 런타임 `config.json`(S3) 패칭으로 리팩터(선택).

### CI 배포 3단계 (보고서 §5.2.3)
```bash
# GitHub Actions
VITE_API_BASE_URL=$PROD_API_URL npm --prefix frontend run build      # dist/ 생성
aws s3 sync frontend/dist s3://<bucket> --delete                      # 동기화
aws cloudfront create-invalidation --distribution-id <id> --paths /index.html  # 무효화(아래 캐시정책상 1건만)
```

---

## 4. CORS (분리 도메인일 때만 — 보고서 §5.2.4)

같은 CloudFront 뒤로 API 를 두면 **불필요**. 분리 도메인이면 **임형택의 API Gateway** 에서:
| 헤더 | 값 |
|---|---|
| Access-Control-Allow-Origin | CloudFront 도메인(자격증명 요청 시 `*` 불가) |
| Access-Control-Allow-Methods | GET, POST, DELETE, OPTIONS (코드 실제 사용 메서드) |
| Access-Control-Allow-Headers | Content-Type, Authorization |
| Access-Control-Allow-Credentials | 쿠키 인증 도입 시 true |
| Access-Control-Max-Age | 86400 |
- dev `http://localhost:5173` 도 allowlist(또는 `/dev` 스테이지 분리).
> 현재 클라는 쿠키/Authorization 미전송이라 단순 요청 위주. 인증 도입 시 헤더/credentials 동기화(§0 차이).

---

## 5. 캐시 정책 (보고서 §5.2.5)
| 자산 | Cache-Control | 근거 |
|---|---|---|
| `assets/*.js,*.css,이미지` | `public, max-age=31536000, immutable` | Vite 파일명 콘텐츠 해시 → 변경 시 새 URL |
| `index.html` | `no-cache, must-revalidate` | 배포 직후 새 자산 참조 즉시 반영 |
→ 배포 후 무효화는 **`/index.html` 1건**이면 충분(월 1,000 경로 무료).

---

## 6. 통신보안 · 보안헤더 (보고서 §6 — 노원우)
- **Viewer Protocol Policy**: `Redirect HTTP to HTTPS`. **TLS 최소 `TLSv1.2_2021`**.
- 커스텀 도메인: ACM 인증서는 **`us-east-1`** 에 발급해야 CloudFront 인식.
- **Response Headers Policy**:
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- (향후) AWS WAF 연결로 SQLi/XSS/Rate Limiting.

---

## 7. 교차 의존성 (Import/Export)
| 필요 값 | 출처 | 사용처 |
|---|---|---|
| API 도메인/스테이지 | 임형택 processing 스택 Output | `VITE_API_BASE_URL`(빌드) 또는 `/api/*` behavior origin |
| CORS allowlist 의 CloudFront 도메인 | 본 스택 Output → 임형택 | API Gateway CORS |
> 본 레이어는 Storage Stack 을 직접 Import 하지 않는다(프론트는 API 만 호출).

## 8. 완료 기준
- [ ] S3(비공개)+CloudFront(OAC) 배포, 직접 S3 접근 차단 확인
- [ ] SPA 딥링크(예: `/settings` 새로고침) → index.html fallback 200
- [ ] `VITE_API_BASE_URL` prod 주입(localhost fallback 미사용) 확인
- [ ] (권장) `/api/*` behavior 로 동일 출처 구성 → CORS 제거, 또는 API Gateway CORS allowlist
- [ ] 캐시 정책(자산 immutable / index.html no-cache) + 무효화 `/index.html`
- [ ] HTTPS 강제, TLSv1.2_2021, 4종 보안헤더 적용
- [ ] (인증 도입 시) `client.js` 토큰 헤더/credentials + 백엔드 CORS 동기화
