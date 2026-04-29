export default function Card({ title, action, children, className = "" }) {
  return (
    <section
      className={`bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between mb-4">
          {title && <h2 className="text-sm font-medium text-[var(--color-text-muted)]">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
