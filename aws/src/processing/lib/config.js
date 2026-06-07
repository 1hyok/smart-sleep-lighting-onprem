'use strict';

module.exports = {
  usersTable: process.env.USERS_TABLE,
  tokensMetaTable: process.env.TOKENS_META_TABLE,
  sessionsTable: process.env.SESSIONS_TABLE,
  stagesTable: process.env.STAGES_TABLE,
  reportsTable: process.env.REPORTS_TABLE,
  illuminTable: process.env.ILLUM_TABLE,
  illuminLatestTable: process.env.ILLUM_LATEST_TABLE,
  schedulesTable: process.env.SCHEDULES_TABLE,
  routinesTable: process.env.ROUTINES_TABLE,
  routineStepsTable: process.env.ROUTINE_STEPS_TABLE,
  deviceStatusTable: process.env.DEVICE_STATUS_TABLE,
  fitbitAppSecretArn: process.env.FITBIT_APP_SECRET_ARN,
  mockFitbit: String(process.env.MOCK_FITBIT).toLowerCase() === 'true',
  defaultDeviceId: process.env.DEFAULT_DEVICE_ID || 'rpi-01',
  defaultThingName: process.env.DEFAULT_THING_NAME || 'rpi-01',
  userTzOffsetHours: Number(process.env.USER_TZ_OFFSET_HOURS || 9),
  projectName: process.env.PROJECT_NAME || 'smartsleep',
  environment: process.env.ENVIRONMENT || 'dev',
};
