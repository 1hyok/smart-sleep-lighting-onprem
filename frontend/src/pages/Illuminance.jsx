import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "../components/Card.jsx";
import QueryState from "../components/QueryState.jsx";
import Stat from "../components/Stat.jsx";
import Tabs from "../components/Tabs.jsx";
import {
  useCurrentIlluminance,
  useIlluminanceHistory,
} from "../hooks/useIlluminance.js";
import { formatTimeShort } from "../lib/format.js";

const HOUR_OPTIONS = [
  { value: 1, label: "1h" },
  { value: 6, label: "6h" },
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
];

function formatTick(t, hours) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  if (hours <= 24) {
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" });
}

export default function Illuminance() {
  const [hours, setHours] = useState(24);
  const current = useCurrentIlluminance();
  const history = useIlluminanceHistory(hours);

  const points = useMemo(() => {
    const raw = history.data?.data ?? [];
    return raw
      .map((r) => ({
        t: Date.parse(r.timestamp),
        value: typeof r.value === "number" ? r.value : Number(r.value),
        deviceId: r.deviceId,
      }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value));
  }, [history.data]);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="현재 조도">
        <QueryState query={current} empty="센서 데이터를 기다리는 중입니다.">
          {current.data && (
            <Stat
              label={current.data.deviceId ?? "sensor"}
              value={
                typeof current.data.value === "number"
                  ? current.data.value.toFixed(1)
                  : current.data.value
              }
              unit="lux"
              hint={
                current.data.timestamp &&
                `측정 시각: ${formatTimeShort(current.data.timestamp)}`
              }
            />
          )}
        </QueryState>
      </Card>

      <Card
        title="조도 추이"
        className="md:col-span-2"
        action={
          <Tabs value={hours} onChange={setHours} options={HOUR_OPTIONS} />
        }
      >
        <QueryState query={history} empty="이 기간 내 데이터가 없습니다.">
          {points.length === 0 ? (
            <div className="text-sm text-[var(--color-text-muted)]">
              이 기간 내 센서 데이터가 없습니다.
            </div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={points}
                  margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3358" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    scale="time"
                    tickFormatter={(t) => formatTick(t, hours)}
                    stroke="#9aa3c0"
                    fontSize={11}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#9aa3c0"
                    fontSize={11}
                    width={40}
                    tickFormatter={(v) => Math.round(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#131a2e",
                      border: "1px solid #2a3358",
                      borderRadius: 8,
                      color: "#e6e9f5",
                      fontSize: 12,
                    }}
                    labelFormatter={(t) =>
                      new Date(t).toLocaleString("ko-KR", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    }
                    formatter={(value) => [
                      `${Number(value).toFixed(1)} lux`,
                      "조도",
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#7c8cff"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            {points.length > 0 && `샘플 수: ${points.length}`}
          </div>
        </QueryState>
      </Card>
    </div>
  );
}
