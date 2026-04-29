// Express REST API 서버.

const express = require('express');
const cors = require('cors');

const lightingRoutes = require('../routes/lighting');
const reportsRoutes = require('../routes/reports');
const illuminanceRoutes = require('../routes/illuminance');
const scheduleRoutes = require('../routes/schedule');
const fitbitRoutes = require('../routes/fitbit');
const deviceRoutes = require('../routes/device');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/api/lighting', lightingRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/illuminance', illuminanceRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use('/api/fitbit', fitbitRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: `404 Not Found: ${req.method} ${req.path}` });
  });

  app.use((err, req, res, _next) => {
    console.error('[SERVER] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function startServer(port) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`[API] REST 서버 시작: http://localhost:${port}`);
    console.log('[API] 사용 가능한 엔드포인트:');
    console.log('  GET    /api/health');
    console.log('  GET    /api/reports?date=YYYY-MM-DD');
    console.log('  GET    /api/reports/recent?days=7');
    console.log('  GET    /api/illuminance/current');
    console.log('  GET    /api/illuminance/history?hours=24');
    console.log('  POST   /api/schedule');
    console.log('  GET    /api/schedule');
    console.log('  DELETE /api/schedule');
    console.log('  GET    /api/fitbit/status');
    console.log('  GET    /api/device/status');
    console.log('  POST   /api/lighting/routine');
  });
  return server;
}

module.exports = { createApp, startServer };