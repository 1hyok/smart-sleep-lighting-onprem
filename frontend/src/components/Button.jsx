const VARIANTS = {
  primary:
    "bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50",
  secondary:
    "bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-border)] disabled:opacity-50",
  danger:
    "bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)]/40 hover:bg-[var(--color-danger)]/10 disabled:opacity-50",
};

export default function Button({
  children,
  variant = "primary",
  type = "button",
  className = "",
  ...props
}) {
  const cls = `px-3 py-2 text-sm rounded-md font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant] ?? VARIANTS.primary} ${className}`;
  return (
    <button type={type} className={cls} {...props}>
      {children}
    </button>
  );
}
