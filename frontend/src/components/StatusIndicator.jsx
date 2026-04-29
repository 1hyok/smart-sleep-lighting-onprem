import { useDeviceStatus, useFitbitStatus } from "../hooks/useStatus";

function Dot({ tone, label, title }) {
  const color =
    tone === "ok"
      ? "bg-[var(--color-accent-2)]"
      : tone === "warn"
        ? "bg-[var(--color-warn)]"
        : tone === "danger"
          ? "bg-[var(--color-danger)]"
          : "bg-[var(--color-text-muted)]";
  return (
    <span title={title} className="flex items-center gap-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

function deviceTone(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return "unknown";
  return devices.some((d) => d?.status === "online") ? "ok" : "danger";
}

function fitbitTone(status) {
  if (status === "connected") return "ok";
  if (status === "expired") return "warn";
  if (status === "not_connected") return "danger";
  return "unknown";
}

export default function StatusIndicator() {
  const device = useDeviceStatus();
  const fitbit = useFitbitStatus();

  const dTone = device.isError ? "danger" : deviceTone(device.data?.devices);
  const fTone = fitbit.isError ? "danger" : fitbitTone(fitbit.data?.status);

  const dTitle = device.error?.message ?? `device: ${dTone}`;
  const fTitle = fitbit.data?.message ?? fitbit.error?.message ?? `fitbit: ${fTone}`;

  return (
    <div className="flex items-center gap-4">
      <Dot tone={dTone} label="센서" title={dTitle} />
      <Dot tone={fTone} label="Fitbit" title={fTitle} />
    </div>
  );
}
