export default function Tabs({ value, onChange, options }) {
  return (
    <div className="inline-flex p-0.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              "px-3 py-1 text-xs rounded-sm transition-colors",
              active
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
