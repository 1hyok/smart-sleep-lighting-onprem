// 조명 루틴 실행기.
// steps 배열을 순차적으로 실행하며, 각 단계마다 GPIO 밝기 조절 + DB 기록.

const { getDbAsync, persist } = require('../db/db');
const { setBrightness } = require('../gpio/light');

const SLEEP_STEPS = [
  { brightness: 80, delayMs: 10 * 60 * 1000 }, // 10분 후 80%
  { brightness: 60, delayMs: 10 * 60 * 1000 }, // 10분 후 60%
  { brightness: 40, delayMs:  5 * 60 * 1000 }, // 5분 후 40%
  { brightness: 20, delayMs:  3 * 60 * 1000 }, // 3분 후 20%
  { brightness:  0, delayMs:  2 * 60 * 1000 }, // 2분 후 0% (소등)
];

const WAKE_STEPS = [
  { brightness: 20, delayMs: 3 * 60 * 1000 },  // 3분 후 20%
  { brightness: 50, delayMs: 4 * 60 * 1000 },  // 4분 후 50%
  { brightness: 80, delayMs: 4 * 60 * 1000 },  // 4분 후 80%
  { brightness:100, delayMs: 4 * 60 * 1000 },  // 4분 후 100% (만개)
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logRoutineStart(userId, routineType, scheduledAt) {
  const db = await getDbAsync();
  const result = db.prepare(`
    INSERT INTO lighting_routines (user_id, routine_type, scheduled_at, started_at, success)
    VALUES (?, ?, ?, datetime('now'), 0)
  `).run(userId, routineType, scheduledAt);
  return result.lastInsertRowid;
}

async function logRoutineStep(routineId, stepIndex, brightnessPct) {
  const db = await getDbAsync();
  db.prepare(`
    INSERT INTO routine_steps (routine_id, step_index, brightness_pct, executed_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(routineId, stepIndex, brightnessPct);
}

async function markRoutineComplete(routineId, success) {
  const db = await getDbAsync();
  db.prepare(`
    UPDATE lighting_routines
    SET completed_at = datetime('now'), success = ?
    WHERE id = ?
  `).run(success ? 1 : 0, routineId);
}

/**
 * @param {number} userId
 * @param {'sleep'|'wake'} routineType
 * @param {string} scheduledAt - ISO 8601 scheduled start time
 * @param {Array<{brightness: number, delayMs: number}>} [steps] - optional custom steps
 */
async function executeRoutine(userId, routineType, scheduledAt, steps) {
  const routineId = await logRoutineStart(userId, routineType, scheduledAt);

  // 기본 steps 또는 커스텀 steps
  const seq = steps ?? (routineType === 'sleep' ? SLEEP_STEPS : WAKE_STEPS);

  try {
    for (let i = 0; i < seq.length; i++) {
      const { brightness, delayMs } = seq[i];
      setBrightness(brightness, false); // 즉시 설정
      await logRoutineStep(routineId, i, brightness);
      console.log(`[ROUTINE] ${routineType} step ${i + 1}/${seq.length}: brightness=${brightness}%`);
      if (i < seq.length - 1) {
        await sleep(delayMs);
      }
    }
    await markRoutineComplete(routineId, true);
    persist();
    console.log(`[ROUTINE] ${routineType} 완료 (routine_id=${routineId})`);
    return { routineId, success: true };
  } catch (err) {
    console.error(`[ROUTINE] ${routineType} 실패:`, err.message);
    await markRoutineComplete(routineId, false);
    persist();
    return { routineId, success: false };
  }
}

module.exports = { executeRoutine, SLEEP_STEPS, WAKE_STEPS };
