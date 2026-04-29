export default function Stat({ label, value, unit, hint }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-text-muted)] mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold text-[var(--color-text)]">{value ?? "-"}</span>
        {unit && <span className="text-sm text-[var(--color-text-muted)]">{unit}</span>}
      </div>
      {hint && <div className="text-xs text-[var(--color-text-muted)] mt-1">{hint}</div>}
    </div>
  );
}
