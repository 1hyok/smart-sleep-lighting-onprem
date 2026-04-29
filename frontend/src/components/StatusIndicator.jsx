import { useDeviceStatus, useFitbitStatus } from "../hooks/useStatus";

function Dot({ ok, label, title }) {
  const color = ok ? "bg-[var(--color-accent-2)]" : "bg-[var(--color-danger)]";
  return (
    <span title={title} className="flex items-center gap-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

export default function StatusIndicator() {
  const device = useDeviceStatus();
  const fitbit = useFitbitStatus();

  const deviceOk = device.data?.online === true || device.data?.status === "online";
  const fitbitOk = fitbit.data?.connected === true;

  return (
    <div className="flex items-center gap-4">
      <Dot ok={deviceOk} label="센서" title={device.error?.message ?? "edge device"} />
      <Dot ok={fitbitOk} label="Fitbit" title={fitbit.error?.message ?? "fitbit oauth"} />
    </div>
  );
}
