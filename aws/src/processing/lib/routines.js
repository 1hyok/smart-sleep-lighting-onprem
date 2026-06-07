'use strict';

const { IoTDataPlaneClient, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');
const { randomUUID } = require('crypto');
const config = require('./config');
const { putItem } = require('./dynamodb');

const SLEEP_STEPS = [
  { brightness: 80, delayMs: 10 * 60 * 1000 },
  { brightness: 60, delayMs: 10 * 60 * 1000 },
  { brightness: 40, delayMs: 5 * 60 * 1000 },
  { brightness: 20, delayMs: 3 * 60 * 1000 },
  { brightness: 0, delayMs: 2 * 60 * 1000 },
];

const WAKE_STEPS = [
  { brightness: 20, delayMs: 3 * 60 * 1000 },
  { brightness: 50, delayMs: 4 * 60 * 1000 },
  { brightness: 80, delayMs: 4 * 60 * 1000 },
  { brightness: 100, delayMs: 4 * 60 * 1000 },
];

let iotData = null;

function getIotData() {
  if (!iotData) {
    iotData = new IoTDataPlaneClient({
      endpoint: process.env.IOT_DATA_ENDPOINT,
    });
  }
  return iotData;
}

async function createRoutineRecord(userId, routineType, scheduledAt) {
  const routineId = `rtn-${randomUUID()}`;
  const now = new Date().toISOString();
  await putItem(config.routinesTable, {
    routine_id: routineId,
    user_id: userId,
    routine_type: routineType,
    scheduled_at: scheduledAt,
    started_at: now,
    success: 0,
  });
  return routineId;
}

async function updateThingShadowRoutine(thingName, routineType, steps, routineId) {
  const endpoint = process.env.IOT_DATA_ENDPOINT;
  if (!endpoint) {
    console.warn('[ROUTINE] IOT_DATA_ENDPOINT 미설정 — Shadow 갱신 스킵');
    return;
  }

  const payload = {
    state: {
      desired: {
        routine: {
          routineId,
          type: routineType,
          steps,
          requestedAt: new Date().toISOString(),
        },
      },
    },
  };

  await getIotData().send(new UpdateThingShadowCommand({
    thingName,
    payload: Buffer.from(JSON.stringify(payload)),
  }));
  console.log(`[ROUTINE] Shadow desired 갱신 thing=${thingName} routine=${routineId}`);
}

async function triggerRoutineAsync(userId, routineType, scheduledAt, customSteps) {
  const steps = customSteps ?? (routineType === 'sleep' ? SLEEP_STEPS : WAKE_STEPS);
  const routineId = await createRoutineRecord(userId, routineType, scheduledAt);
  await updateThingShadowRoutine(config.defaultThingName, routineType, steps, routineId);
  return { routineId, success: true };
}

module.exports = {
  SLEEP_STEPS,
  WAKE_STEPS,
  createRoutineRecord,
  updateThingShadowRoutine,
  triggerRoutineAsync,
};
