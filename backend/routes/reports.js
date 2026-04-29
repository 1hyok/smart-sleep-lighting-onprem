// GET /api/reports?date=YYYY-MM-DD
// GET /api/reports/recent?days=7

const express = require('express');
const { getDbAsync } = require('../db/db');
const { getPrimaryUserId } = require('../services/activeUser');

const router = express.Router();

function transformReport(report) {
  return {
    date: report.report_date,
    sleep: report.minutes_asleep != null ? {
      startTime: report.start_time,
      endTime: report.end_time,
      minutesAsleep: report.minutes_asleep,
      efficiency: report.efficiency,
      stages: {
        deep: report.deep_minutes ?? null,
        rem: report.rem_minutes ?? null,
        light: report.light_minutes ?? null,
        wake: report.wake_minutes ?? null,
      },
    } : null,
    lighting: {
      sleepRoutineExecuted: !!report.sleep_routine_id,
      wakeRoutineExecuted: !!report.wake_routine_id,
      avgIlluminanceBedtime: report.avg_illuminance_bedtime ?? null,
      avgIlluminanceWakeup: report.avg_illuminance_wakeup ?? null,
    },
  };
}

router.get('/', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query required: YYYY-MM-DD' });
  }

  const userId = await getPrimaryUserId();
  const db = await getDbAsync();
  const report = db.prepare(`
    SELECT r.*,
           s.start_time, s.end_time, s.minutes_asleep, s.efficiency,
           dst.deep_minutes, dst.rem_minutes, dst.light_minutes, dst.wake_minutes
    FROM sleep_reports r
    LEFT JOIN sleep_sessions s ON s.id = r.sleep_session_id
    LEFT JOIN (
      SELECT session_id,
        MAX(CASE WHEN stage='deep'  THEN minutes END) AS deep_minutes,
        MAX(CASE WHEN stage='rem'   THEN minutes END) AS rem_minutes,
        MAX(CASE WHEN stage='light' THEN minutes END) AS light_minutes,
        MAX(CASE WHEN stage='wake'  THEN minutes END) AS wake_minutes
      FROM sleep_stages GROUP BY session_id
    ) dst ON dst.session_id = s.id
    WHERE r.user_id = ? AND r.report_date = ?
    LIMIT 1
  `).get(userId, date);

  if (!report) {
    return res.status(404).json({ error: `리포트가 없습니다: ${date}` });
  }

  res.json(transformReport(report));
});

router.get('/recent', async (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
  const userId = await getPrimaryUserId();
  const db = await getDbAsync();
  const reports = db.prepare(`
    SELECT r.*,
           s.start_time, s.end_time, s.minutes_asleep, s.efficiency,
           dst.deep_minutes, dst.rem_minutes, dst.light_minutes, dst.wake_minutes
    FROM sleep_reports r
    LEFT JOIN sleep_sessions s ON s.id = r.sleep_session_id
    LEFT JOIN (
      SELECT session_id,
        MAX(CASE WHEN stage='deep'  THEN minutes END) AS deep_minutes,
        MAX(CASE WHEN stage='rem'   THEN minutes END) AS rem_minutes,
        MAX(CASE WHEN stage='light' THEN minutes END) AS light_minutes,
        MAX(CASE WHEN stage='wake'  THEN minutes END) AS wake_minutes
      FROM sleep_stages GROUP BY session_id
    ) dst ON dst.session_id = s.id
    WHERE r.user_id = ?
    ORDER BY r.report_date DESC
    LIMIT ?
  `).all(userId, days);

  res.json(reports.map(transformReport));
});

module.exports = router;
