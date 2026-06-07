// ──────────────────────────────────────────────
// logger.js  — 경량 타임스탬프 로거.
//  - 외부 의존성 없이 콘솔에 [시각] [LEVEL] [scope] 형식으로 출력.
//  - LOG_LEVEL 환경변수로 출력 임계 조절 (debug < info < warn < error).
// ──────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function buildLogger(scope) {
  const emit = (level, stream, args) => {
    if (LEVELS[level] < THRESHOLD) return;
    stream(`[${ts()}] [${level.toUpperCase()}] [${scope}]`, ...args);
  };
  return {
    debug: (...a) => emit('debug', console.debug, a),
    info: (...a) => emit('info', console.log, a),
    warn: (...a) => emit('warn', console.warn, a),
    error: (...a) => emit('error', console.error, a),
  };
}

module.exports = buildLogger;
