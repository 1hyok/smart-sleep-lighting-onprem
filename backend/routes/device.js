// GET /api/device/status — 엣지 노드 MQTT home/edge/status 최신 상태 목록.

const express = require('express');
const { snapshotList } = require('../pipeline/deviceStatusStore');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ devices: snapshotList() });
});

module.exports = router;
