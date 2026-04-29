// GET /api/illuminance/current
// GET /api/illuminance/history?hours=24

const express = require('express');
const { getDbAsync } = require('../db/db');

const router = express.Router();

router.get('/current', async (req, res) => {
  const db = await getDbAsync();
  const row = db.prepare(`
    SELECT value, device_id, source, recorded_at
    FROM illuminance_readings
    WHERE source = 'sensor'
    ORDER BY recorded_at DESC
    LIMIT 1
  `).get();

  if (!row) {
    return res.status(404).json({ error: '조도 데이터가 없습니다' });
  }

  res.json({
    deviceId: row.device_id,
    value: row.value,
    source: row.source,
    timestamp: row.recorded_at,
  });
});

router.get('/history', async (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
  const db = await getDbAsync();

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT device_id, value, recorded_at
    FROM illuminance_readings
    WHERE source = 'sensor' AND recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(since);

  res.json({
    hours,
    count: rows.length,
    data: rows.map((r) => ({
      deviceId: r.device_id,
      value: r.value,
      timestamp: r.recorded_at,
    })),
  });
});

module.exports = router;