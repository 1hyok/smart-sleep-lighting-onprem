// ──────────────────────────────────────────────
// webServer.js
//  - Express 기반 로컬 대시보드 + 제어 REST API.
//  - 기능:
//     · GET  /                    → 정적 HTML (public/index.html)
//     · GET  /api/state           → 현재 엣지 노드 상태
//     · GET  /api/logs?limit=N    → service_log.jsonl 최근 N개
//     · GET  /api/stream          → SSE: 실시간 조도값 푸시
//     · POST /api/routine/sleep   → routine/sleep 발행
//     · POST /api/routine/wakeup  → routine/wakeup 발행
//     · POST /api/light/off       → 현재 루틴 취소 + 조명 강제 OFF
//  - 동일 프로세스에서 MQTT 클라이언트를 공유해 추가 auth/연결 없이 발행.
//  - edge-light.service 내부에서 index.js 가 start() 를 호출.
// ──────────────────────────────────────────────

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const eventLogger = require('./eventLogger');
const buildLogger = require('./logger');

const log = buildLogger('web');

// SSE 연결된 클라이언트(res 객체) 집합
const sseClients = new Set();

// 최근 조도값 캐시 (새 클라이언트가 붙자마자 즉시 보여주기 위함)
let lastLux = null;

/**
 * 연결된 모든 SSE 클라이언트에 이벤트 푸시.
 * @param {string} event - SSE 이벤트 이름 (예: 'lux')
 * @param {object} data - JSON 직렬화 가능한 페이로드
 */
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (_) {
      // 연결 오류는 무시 — req.on('close') 에서 자동 제거됨
    }
  }
}

/**
 * 조도값 브로드캐스트 헬퍼 (index.js 의 publishSensorReading 에서 호출).
 */
function broadcastLux(payload) {
  lastLux = payload;
  broadcast('lux', payload);
}

/**
 * Express 서버 시작.
 * @param {object} deps
 * @param {(topic: string, message: any) => void} deps.publishMqtt
 *   - 동일 프로세스의 MQTT 클라이언트 publish 함수를 주입.
 */
function start({ publishMqtt }) {
  const app = express();
  app.use(express.json());

  // 정적 파일 (대시보드 UI)
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 상태 조회
  app.get('/api/state', (_req, res) => {
    res.json({
      deviceId: config.mqtt.clientId,
      topics: config.topics,
      lastLux,
      connectedSseClients: sseClients.size,
      serverTime: new Date().toISOString(),
    });
  });

  // ── 최근 로그 (service_log.jsonl 의 마지막 N줄)
  app.get('/api/logs', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
    const logPath = eventLogger.getPath();

    let events = [];
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      events = lines
        .slice(-limit)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      log.warn(`로그 파일 읽기 실패: ${err.message}`);
    }
    res.json({ count: events.length, events });
  });

  // ── SSE: 실시간 조도값 스트림
  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 대비
    });
    res.flushHeaders();
    res.write(': connected\n\n');

    sseClients.add(res);
    log.info(`SSE 클라이언트 연결 (+1 → ${sseClients.size}명)`);

    // 최근값 즉시 푸시
    if (lastLux) {
      res.write(`event: lux\ndata: ${JSON.stringify(lastLux)}\n\n`);
    }

    req.on('close', () => {
      sseClients.delete(res);
      log.info(`SSE 클라이언트 해제 (-1 → ${sseClients.size}명)`);
    });
  });

  // ── 루틴 트리거 (공통 핸들러)
  app.post('/api/routine/:name', (req, res) => {
    const name = req.params.name;
    const topicMap = {
      sleep: config.topics.routineSleep,
      wakeup: config.topics.routineWakeup,
    };
    const topic = topicMap[name];
    if (!topic) {
      return res.status(400).json({ error: `unknown routine: ${name}` });
    }
    // 페이로드를 바디로 전달 가능 (ex. { duration: 30000 }). 빈 오브젝트면 기본값 사용.
    const payload = req.body && Object.keys(req.body).length ? req.body : '';
    publishMqtt(topic, payload);
    log.info(`웹 API: ${name} 루틴 트리거 발행 (payload=${JSON.stringify(payload || '')})`);
    res.json({ ok: true, routine: name, topic, payload });
  });

  // ── 조명 강제 OFF (진행 중인 루틴 취소 + OFF)
  app.post('/api/light/off', (_req, res) => {
    publishMqtt(config.topics.routineSleep, 'cancel');
    publishMqtt(config.topics.lightControl, 'OFF');
    log.info('웹 API: 조명 강제 OFF (루틴 취소 + OFF 발행)');
    res.json({ ok: true });
  });

  // ── 기동
  const port = config.web.port;
  const server = app.listen(port, '0.0.0.0', () => {
    log.info(`대시보드 서버 기동: http://0.0.0.0:${port}`);
  });

  server.on('error', (err) => {
    log.error(`대시보드 서버 오류: ${err.message}`);
  });

  return server;
}

module.exports = { start, broadcastLux, broadcast };
