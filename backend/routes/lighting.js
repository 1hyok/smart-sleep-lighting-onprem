// POST /api/lighting/routine
// 수동으로 조명 루틴을 즉시 실행.
// Body: { type: 'sleep'|'wake', steps?: [{brightness, delayMs}] }

const express = require('express');
const { executeRoutine } = require('../services/lightingExecutor');
const { getPrimaryUserId } = require('../services/activeUser');

const router = express.Router();

/** 유효하면 단계 배열, 아니면 { error: string } */
function parseRoutineSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { error: 'steps must be a non-empty array' };
  }
  const parsed = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof s.brightness !== 'number' || s.brightness < 0 || s.brightness > 100) {
      return { error: `step[${i}].brightness must be 0~100` };
    }
    if (typeof s.delayMs !== 'number' || s.delayMs < 0) {
      return { error: `step[${i}].delayMs must be a non-negative number` };
    }
    parsed.push({ brightness: s.brightness, delayMs: s.delayMs });
  }
  return { steps: parsed };
}

router.post('/routine', async (req, res) => {
  const { type, steps, scheduledAt } = req.body;

  if (!type || !['sleep', 'wake'].includes(type)) {
    return res.status(400).json({ error: 'type must be "sleep" or "wake"' });
  }

  let parsedSteps = null;
  if (steps !== undefined) {
    const checked = parseRoutineSteps(steps);
    if (checked.error) {
      return res.status(400).json({ error: checked.error });
    }
    parsedSteps = checked.steps;
  }

  const scheduled = scheduledAt || new Date().toISOString();

  try {
    const userId = await getPrimaryUserId();
    const result = await executeRoutine(userId, type, scheduled, parsedSteps);
    res.json({
      success: result.success,
      routineId: result.routineId,
      message: `${type} 루틴이${result.success ? ' 완료' : ' 실패'}했습니다.`,
    });
  } catch (err) {
    console.error('[lighting] POST /api/lighting/routine 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
