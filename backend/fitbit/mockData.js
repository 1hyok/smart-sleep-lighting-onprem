// MOCK_FITBIT=true 일 때 사용하는 현실적인 가짜 수면 데이터 생성기.
// 실제 Fitbit API 응답 스키마(/1.2/user/-/sleep/date/{date}) 형식을 그대로 모방.

function sleepForDate(date) {
  // 23:00 ± 30분 취침, 07:00 ± 20분 기상
  const jitter = (min) => Math.floor(Math.random() * min * 2 - min);
  const startHour = 23;
  const startMin = jitter(30);
  const endHour = 7;
  const endMin = jitter(20);

  const startTime = new Date(`${date}T${String(startHour).padStart(2,'0')}:${String(Math.abs(startMin)).padStart(2,'0')}:00.000`);
  const endDate = new Date(startTime);
  endDate.setDate(endDate.getDate() + 1);
  endDate.setHours(endHour, Math.abs(endMin), 0, 0);

  const durationMs = endDate.getTime() - startTime.getTime();
  const durationMin = Math.floor(durationMs / 60000);

  const deep  = Math.floor(durationMin * 0.20);
  const rem   = Math.floor(durationMin * 0.22);
  const wake  = Math.floor(durationMin * 0.06);
  const light = durationMin - deep - rem - wake;

  const fmt = (d) => d.toISOString().replace('Z', '').slice(0, 23);

  return {
    sleep: [
      {
        logId: Date.now(),
        dateOfSleep: date,
        startTime: fmt(startTime),
        endTime: fmt(endDate),
        duration: durationMs,
        minutesAsleep: durationMin - wake,
        minutesAwake: wake,
        timeInBed: durationMin,
        efficiency: 88 + Math.floor(Math.random() * 10),
        isMainSleep: true,
        type: 'stages',
        levels: {
          summary: {
            deep:  { minutes: deep,  count: 5,  thirtyDayAvgMinutes: deep  - 2 },
            light: { minutes: light, count: 28, thirtyDayAvgMinutes: light + 5 },
            rem:   { minutes: rem,   count: 4,  thirtyDayAvgMinutes: rem   - 3 },
            wake:  { minutes: wake,  count: 20, thirtyDayAvgMinutes: wake  + 1 },
          },
        },
      },
    ],
    summary: {
      totalMinutesAsleep: durationMin - wake,
      totalSleepRecords: 1,
      totalTimeInBed: durationMin,
    },
  };
}

module.exports = { sleepForDate };
