export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="block text-xs text-[var(--color-text-muted)] mb-1">
        {label}
      </span>
      {children}
      {error ? (
        <span className="block mt-1 text-xs text-[var(--color-danger)]">
          {error}
        </span>
      ) : hint ? (
        <span className="block mt-1 text-xs text-[var(--color-text-muted)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

const inputBase =
  "w-full px-3 py-2 text-sm rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]";

export function TextInput({ className = "", ...props }) {
  return <input className={`${inputBase} ${className}`} {...props} />;
}

export function NumberInput({ className = "", ...props }) {
  return <input type="number" className={`${inputBase} ${className}`} {...props} />;
}

export function TimeInput({ className = "", ...props }) {
  return <input type="time" className={`${inputBase} ${className}`} {...props} />;
}

export function Checkbox({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="w-4 h-4 accent-[var(--color-accent)]"
      />
      <span>{label}</span>
    </label>
  );
}
