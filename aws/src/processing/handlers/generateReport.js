'use strict';

const { generateReport } = require('../lib/reports');

exports.handler = async (event) => {
  const failures = [];

  for (const record of event.Records ?? []) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;

    try {
      const img = record.dynamodb?.NewImage;
      if (!img) continue;

      const userId = img.user_id?.S;
      const sk = img.sk?.S;
      if (!userId || !sk) continue;

      const date = sk.split('#')[0];
      await generateReport(userId, date);
    } catch (err) {
      console.error('[REPORT] Stream 처리 실패:', err.message);
      failures.push(err.message);
    }
  }

  if (failures.length) {
    throw new Error(`generateReport failures: ${failures.join('; ')}`);
  }

  return { processed: event.Records?.length ?? 0 };
};
