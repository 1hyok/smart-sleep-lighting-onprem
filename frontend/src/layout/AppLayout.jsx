import { NavLink, Outlet } from "react-router-dom";
import StatusIndicator from "../components/StatusIndicator.jsx";

const NAV = [
  { to: "/", label: "대시보드", end: true },
  { to: "/history", label: "수면 히스토리" },
  { to: "/illuminance", label: "조도 모니터링" },
  { to: "/settings", label: "설정" },
];

export default function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-accent)]" />
            <h1 className="text-lg font-semibold tracking-tight">
              Smart Sleep Lighting
            </h1>
          </div>
          <StatusIndicator />
        </div>
        <nav className="max-w-6xl mx-auto px-6 flex gap-1 overflow-x-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  "px-3 py-2 text-sm rounded-t-md border-b-2 transition-colors whitespace-nowrap",
                  isActive
                    ? "border-[var(--color-accent)] text-[var(--color-text)]"
                    : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
                ].join(" ")
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-[var(--color-border)] py-3 text-center text-xs text-[var(--color-text-muted)]">
        on-prem · Raspberry Pi · {new Date().getFullYear()}
      </footer>
    </div>
  );
}
