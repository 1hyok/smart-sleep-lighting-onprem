import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "../components/Card.jsx";
import QueryState from "../components/QueryState.jsx";
import Tabs from "../components/Tabs.jsx";
import Stat from "../components/Stat.jsx";
import { useRecentReports } from "../hooks/useReports.js";

const RANGE_OPTIONS = [
  { value: 7, label: "7일" },
  { value: 30, label: "30일" },
];

const STAGE_COLORS = {
  deep: "#4cd2c0",
  rem: "#7c8cff",
  light: "#9aa3c0",
  wake: "#ffb84d",
};

function formatDateLabel(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" });
}

function buildSeries(reports) {
  // 백엔드는 date DESC로 반환 → 차트용 ASC로 뒤집기
  return [...reports]
    .reverse()
    .filter((r) => r && r.sleep)
    .map((r) => ({
      date: r.date,
      label: formatDateLabel(r.date),
      efficiency: r.sleep.efficiency ?? null,
      hours: r.sleep.minutesAsleep != null ? +(r.sleep.minutesAsleep / 60).toFixed(2) : null,
      deep: r.sleep.stages?.deep ?? 0,
      rem: r.sleep.stages?.rem ?? 0,
      light: r.sleep.stages?.light ?? 0,
      wake: r.sleep.stages?.wake ?? 0,
      hadSleepRoutine: !!r.lighting?.sleepRoutineExecuted,
      hadWakeRoutine: !!r.lighting?.wakeRoutineExecuted,
    }));
}

function average(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export default function History() {
  const [days, setDays] = useState(7);
  const reports = useRecentReports(days);

  const series = useMemo(() => buildSeries(reports.data ?? []), [reports.data]);

  const stats = useMemo(() => {
    const avgEff = average(series.map((s) => s.efficiency));
    const avgHours = average(series.map((s) => s.hours));
    const routineDays = series.filter((s) => s.hadSleepRoutine).length;
    return {
      count: series.length,
      avgEff: avgEff != null ? Math.round(avgEff) : null,
      avgHours: avgHours != null ? avgHours.toFixed(1) : null,
      routineDays,
    };
  }, [series]);

  return (
    <div className="space-y-4">
      <Card
        title={`최근 ${days}일 요약`}
        action={<Tabs value={days} onChange={setDays} options={RANGE_OPTIONS} />}
      >
        <QueryState query={reports} empty="아직 수면 리포트가 없습니다.">
          {series.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">
              표시할 수면 데이터가 없습니다.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat label="기록일 수" value={stats.count} unit="일" />
              <Stat label="평균 효율" value={stats.avgEff ?? "-"} unit="%" />
              <Stat label="평균 수면" value={stats.avgHours ?? "-"} unit="h" />
              <Stat
                label="취침 루틴 사용"
                value={stats.routineDays}
                unit={`/ ${stats.count}일`}
              />
            </div>
          )}
        </QueryState>
      </Card>

      {series.length > 0 && (
        <>
          <Card title="수면 효율 추이">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={series}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3358" />
                  <XAxis
                    dataKey="label"
                    stroke="#9aa3c0"
                    fontSize={11}
                    minTickGap={20}
                  />
                  <YAxis
                    stroke="#9aa3c0"
                    fontSize={11}
                    width={40}
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}`}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v) => [`${v}%`, "효율"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="efficiency"
                    stroke="#4cd2c0"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="수면 단계 분포 (분)">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={series}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3358" />
                  <XAxis
                    dataKey="label"
                    stroke="#9aa3c0"
                    fontSize={11}
                    minTickGap={20}
                  />
                  <YAxis stroke="#9aa3c0" fontSize={11} width={40} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v, name) => [`${v}분`, stageLabel(name)]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 12, color: "#9aa3c0" }}
                    formatter={(name) => stageLabel(name)}
                  />
                  <Bar dataKey="deep" stackId="s" fill={STAGE_COLORS.deep} />
                  <Bar dataKey="rem" stackId="s" fill={STAGE_COLORS.rem} />
                  <Bar dataKey="light" stackId="s" fill={STAGE_COLORS.light} />
                  <Bar dataKey="wake" stackId="s" fill={STAGE_COLORS.wake} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

const tooltipStyle = {
  background: "#131a2e",
  border: "1px solid #2a3358",
  borderRadius: 8,
  color: "#e6e9f5",
  fontSize: 12,
};

function stageLabel(key) {
  switch (key) {
    case "deep":
      return "Deep";
    case "rem":
      return "REM";
    case "light":
      return "Light";
    case "wake":
      return "Wake";
    default:
      return key;
  }
}
