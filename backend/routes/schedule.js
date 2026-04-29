// POST /api/schedule   → 취침/기상 시각 설정
// GET  /api/schedule   → 현재 스케줄 조회
// DELETE /api/schedule → 스케줄 삭제

const express = require('express');
const { getDbAsync } = require('../db/db');
const { getPrimaryUserId } = require('../services/activeUser');

const router = express.Router();

function formatSchedule(row) {
  return {
    id: row.id,
    sleepTime: row.sleep_time,
    wakeTime: row.wake_time,
    sleepOffsetMin: row.sleep_offset_min,
    wakeOffsetMin: row.wake_offset_min,
    enabled: !!row.enabled,
    lastSleepTriggered: row.last_sleep_triggered ?? null,
    lastWakeTriggered: row.last_wake_triggered ?? null,
  };
}

router.get('/', async (req, res) => {
  const userId = await getPrimaryUserId();
  const db = await getDbAsync();
  const row = db.prepare('SELECT * FROM schedules WHERE user_id = ?').get(userId);

  if (!row) {
    return res.status(404).json({ error: '설정된 스케줄이 없습니다. POST로 설정하세요.' });
  }

  res.json(formatSchedule(row));
});

router.post('/', async (req, res) => {
  const { sleepTime, wakeTime, sleepOffsetMin, wakeOffsetMin, enabled } = req.body;

  if (!sleepTime || !wakeTime) {
    return res.status(400).json({ error: 'sleepTime과 wakeTime(HH:MM 형식)이 필요합니다.' });
  }

  if (!/^\d{2}:\d{2}$/.test(sleepTime) || !/^\d{2}:\d{2}$/.test(wakeTime)) {
    return res.status(400).json({ error: '시간 형식은 HH:MM이어야 합니다.' });
  }

  const sleepMin = sleepTime.split(':').map(Number).reduce((a, b) => a * 60 + b);
  const wakeMin = wakeTime.split(':').map(Number).reduce((a, b) => a * 60 + b);
  if (sleepMin === wakeMin) {
    return res.status(400).json({ error: '취침과 기상 시각이 같습니다.' });
  }

  const sleepOffset = parseInt(sleepOffsetMin) || 30;
  const wakeOffset = parseInt(wakeOffsetMin) || 15;
  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

  const userId = await getPrimaryUserId();
  const db = await getDbAsync();
  db.prepare(`
    INSERT INTO schedules (user_id, sleep_time, wake_time, sleep_offset_min, wake_offset_min, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      sleep_time       = excluded.sleep_time,
      wake_time        = excluded.wake_time,
      sleep_offset_min = excluded.sleep_offset_min,
      wake_offset_min  = excluded.wake_offset_min,
      enabled          = excluded.enabled,
      updated_at       = datetime('now')
  `).run(userId, sleepTime, wakeTime, sleepOffset, wakeOffset, isEnabled);

  const row = db.prepare('SELECT * FROM schedules WHERE user_id = ?').get(userId);
  console.log(`[SCHEDULE] 설정 저장: sleep=${sleepTime}, wake=${wakeTime}`);
  res.json({ message: '스케줄이 저장되었습니다.', schedule: formatSchedule(row) });
});

router.delete('/', async (req, res) => {
  const userId = await getPrimaryUserId();
  const db = await getDbAsync();
  const { changes } = db.prepare('DELETE FROM schedules WHERE user_id = ?').run(userId);
  if (!changes) return res.status(404).json({ error: '삭제할 스케줄이 없습니다.' });
  res.json({ message: '스케줄이 삭제되었습니다.' });
});

module.exports = router;
