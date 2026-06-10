// 데모/스크린샷용 가짜 API 응답 생성기.
//
// VITE_USE_MOCK=true 일 때 client.js가 네트워크 fetch 대신 이 모듈을 호출합니다.
// 백엔드(Express/MQTT/SQLite)를 전혀 띄우지 않아도 모든 화면이 "연결된 것처럼"
// 채워진 상태로 렌더되므로, 보고서용 캡처에 사용합니다.
//
// 응답 구조는 backend/server 의 실제 라우트 응답과 동일하게 맞춰져 있습니다.
// (pages/hooks 가 소비하는 필드 기준)

const DEVICE_ID = "rpi-edge-bedroom-01";

// ── 시간 포맷 유틸 ────────────────────────────────────────────────────────────
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function isoLocal(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function dateOnly(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 날짜별로 고정된 의사난수 → 폴링 때마다 값이 튀지 않아 캡처가 안정적.
function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mockError(status, message) {
  const err = new Error(message);
  err.name = "ApiError";
  err.status = status;
  return err;
}

// ── 데이터 생성 ───────────────────────────────────────────────────────────────

// 최근 N일 수면 리포트 (백엔드와 동일하게 date DESC: index 0 = 가장 최근)
function buildReports(days) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const target = new Date(today);
    target.setDate(target.getDate() - i);
    const rnd = seeded(
      target.getFullYear() * 10000 + (target.getMonth() + 1) * 100 + target.getDate(),
    );

    const start = new Date(target);
    start.setDate(start.getDate() - 1);
    start.setHours(23, Math.floor(rnd() * 40) - 20, 0, 0); // 22:40 ~ 23:20

    const end = new Date(target);
    end.setHours(7, Math.floor(rnd() * 30) - 15, 0, 0); // 06:45 ~ 07:15

    const totalMin = Math.round((end.getTime() - start.getTime()) / 60_000);
    const wake = Math.floor(totalMin * 0.06);
    const deep = Math.floor(totalMin * 0.2);
    const rem = Math.floor(totalMin * 0.22);
    const light = totalMin - deep - rem - wake;
    const efficiency = 86 + Math.floor(rnd() * 11); // 86 ~ 96

    out.push({
      date: dateOnly(target),
      sleep: {
        minutesAsleep: totalMin - wake,
        minutesAwake: wake,
        timeInBed: totalMin,
        efficiency,
        startTime: isoLocal(start),
        endTime: isoLocal(end),
        stages: { deep, rem, light, wake },
      },
      lighting: {
        sleepRoutineExecuted: true,
        wakeRoutineExecuted: true,
      },
    });
  }
  return out;
}

// 조도 곡선: 낮(7~19시) 높고 밤 낮음
function luxAt(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 7 && hour <= 19) {
    return Math.max(50, 600 - Math.abs(hour - 12) * 60);
  }
  return 6;
}

function buildIlluminanceHistory(hours) {
  const now = Date.now();
  const span = hours * 3600 * 1000;
  const step =
    hours <= 1 ? 60_000 : hours <= 6 ? 2 * 60_000 : hours <= 24 ? 5 * 60_000 : 30 * 60_000;

  const data = [];
  for (let t = now - span; t <= now; t += step) {
    const d = new Date(t);
    const rnd = seeded(Math.floor(t / step));
    const base = luxAt(d);
    const noise = (rnd() - 0.5) * 24;
    data.push({
      timestamp: new Date(t).toISOString(),
      value: Math.max(0, +(base + noise).toFixed(1)),
      deviceId: DEVICE_ID,
    });
  }
  return { deviceId: DEVICE_ID, hours, count: data.length, data };
}

function currentIlluminance() {
  const now = new Date();
  const base = luxAt(now);
  const value = Math.max(0, +(base + (Math.random() - 0.5) * 16).toFixed(1));
  return { deviceId: DEVICE_ID, value, raw: Math.floor(Math.random() * 256), timestamp: now.toISOString() };
}

function scheduleData() {
  const now = new Date();
  const lastSleep = new Date(now);
  lastSleep.setDate(now.getDate() - 1);
  lastSleep.setHours(22, 30, 0, 0);
  const lastWake = new Date(now);
  lastWake.setHours(6, 45, 0, 0);

  return {
    id: 1,
    sleepTime: "23:00",
    wakeTime: "07:00",
    sleepOffsetMin: 30,
    wakeOffsetMin: 15,
    enabled: true,
    lastSleepTriggered: isoLocal(lastSleep),
    lastWakeTriggered: isoLocal(lastWake),
  };
}

function fitbitStatus() {
  const now = new Date();
  const lastSync = new Date(now);
  lastSync.setHours(7, 0, 0, 0);
  const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  return {
    status: "connected",
    message: "정상 동기화 중 (데모)",
    lastSyncAt: isoLocal(lastSync),
    expiresAt: expiresAt.toISOString(),
  };
}

function deviceStatus() {
  return {
    devices: [
      {
        deviceId: DEVICE_ID,
        status: "online",
        rssi: -52,
        lastSeen: new Date().toISOString(),
      },
    ],
  };
}

function health() {
  return { status: "ok", uptimeSec: 86_400, db: "ok", mqtt: "connected", mode: "mock" };
}

// ── 라우터 ────────────────────────────────────────────────────────────────────

export async function mockRequest(path, { method = "GET", body } = {}) {
  await delay(120 + Math.random() * 100); // 로딩 상태가 자연스럽게 보이도록 약간 지연
  void body;

  const [pathname, queryString = ""] = path.split("?");
  const params = new URLSearchParams(queryString);
  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };

  if (method === "GET" && pathname === "/api/health") return health();

  if (method === "GET" && pathname === "/api/reports/recent") {
    return buildReports(toInt(params.get("days"), 7));
  }
  if (method === "GET" && pathname === "/api/reports") {
    const date = params.get("date");
    const found = buildReports(60).find((r) => r.date === date);
    if (!found) throw mockError(404, "해당 날짜의 리포트가 없습니다.");
    return found;
  }

  if (method === "GET" && pathname === "/api/illuminance/current") return currentIlluminance();
  if (method === "GET" && pathname === "/api/illuminance/history") {
    return buildIlluminanceHistory(toInt(params.get("hours"), 24));
  }

  if (method === "GET" && pathname === "/api/schedule") return scheduleData();
  if (method === "POST" && pathname === "/api/schedule") {
    return { message: "스케줄이 저장되었습니다. (데모 모드)" };
  }
  if (method === "DELETE" && pathname === "/api/schedule") {
    return { message: "스케줄이 삭제되었습니다. (데모 모드)" };
  }

  if (method === "GET" && pathname === "/api/fitbit/status") return fitbitStatus();
  if (method === "GET" && pathname === "/api/device/status") return deviceStatus();

  if (method === "POST" && pathname === "/api/lighting/routine") {
    return { success: true, message: "조명 루틴을 실행했습니다. (데모 모드)" };
  }

  throw mockError(404, `mock: 정의되지 않은 경로 ${method} ${pathname}`);
}

// `npm run dev:mock` / `build:mock` (= vite --mode mock) 일 때만 켜진다.
// MODE 기반이라 별도 .env 파일이 필요 없고, 일반 빌드에선 트리셰이킹으로 제거된다.
export const USE_MOCK = import.meta.env.MODE === "mock";
