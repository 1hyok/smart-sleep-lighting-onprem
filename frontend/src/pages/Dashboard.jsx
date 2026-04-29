import Card from "../components/Card.jsx";
import Stat from "../components/Stat.jsx";
import QueryState from "../components/QueryState.jsx";
import { useRecentReports } from "../hooks/useReports.js";
import { useCurrentIlluminance } from "../hooks/useIlluminance.js";
import { formatMinutesAsHM, formatTimeShort } from "../lib/format.js";

export default function Dashboard() {
  const recent = useRecentReports(1);
  const lux = useCurrentIlluminance();
  const today = recent.data?.[0];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="오늘의 수면" className="md:col-span-2">
        <QueryState query={recent} empty="아직 수면 리포트가 없습니다.">
          {today?.sleep ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat
                label="수면 시간"
                value={formatMinutesAsHM(today.sleep.minutesAsleep)}
              />
              <Stat label="효율" value={today.sleep.efficiency} unit="%" />
              <Stat label="취침" value={formatTimeShort(today.sleep.startTime)} />
              <Stat label="기상" value={formatTimeShort(today.sleep.endTime)} />
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)]">
              오늘 수면 데이터가 아직 동기화되지 않았습니다.
            </div>
          )}
        </QueryState>
      </Card>

      <Card title="현재 조도">
        <QueryState query={lux} empty="센서 데이터가 없습니다.">
          <Stat
            label={lux.data?.deviceId ?? "sensor"}
            value={lux.data?.value?.toFixed?.(1) ?? lux.data?.value}
            unit="lux"
            hint={lux.data?.timestamp && `측정: ${formatTimeShort(lux.data.timestamp)}`}
          />
        </QueryState>
      </Card>

      <Card title="조명 루틴">
        {today?.lighting ? (
          <ul className="space-y-2 text-sm">
            <li>
              취침 루틴 ·{" "}
              <span className={today.lighting.sleepRoutineExecuted ? "text-[var(--color-accent-2)]" : "text-[var(--color-text-muted)]"}>
                {today.lighting.sleepRoutineExecuted ? "실행됨" : "미실행"}
              </span>
            </li>
            <li>
              기상 루틴 ·{" "}
              <span className={today.lighting.wakeRoutineExecuted ? "text-[var(--color-accent-2)]" : "text-[var(--color-text-muted)]"}>
                {today.lighting.wakeRoutineExecuted ? "실행됨" : "미실행"}
              </span>
            </li>
          </ul>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)]">
            루틴 기록이 없습니다.
          </div>
        )}
      </Card>
    </div>
  );
}
