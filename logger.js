// ──────────────────────────────────────────────
// logger.js
//  - 간단한 콘솔 로거 래퍼.
//  - 시간 포맷 + 로그레벨 + 태그(모듈명) 형태로 출력하여
//    여러 모듈의 로그가 섞여도 추적이 쉽도록 합니다.
// ──────────────────────────────────────────────

function ts() {
  // ISO 시간 문자열 (예: 2026-04-19T12:34:56.789Z)
  return new Date().toISOString();
}

// 레벨별 메서드를 생성하는 팩토리 함수
function buildLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    info: (...args) => console.log(`${ts()}  INFO  ${prefix}`, ...args),
    warn: (...args) => console.warn(`${ts()}  WARN  ${prefix}`, ...args),
    error: (...args) => console.error(`${ts()}  ERROR ${prefix}`, ...args),
    debug: (...args) => {
      // DEBUG=true 일 때만 출력 (운영 시 소음 방지)
      if (process.env.DEBUG === 'true') {
        console.log(`${ts()}  DEBUG ${prefix}`, ...args);
      }
    },
  };
}

module.exports = buildLogger;
