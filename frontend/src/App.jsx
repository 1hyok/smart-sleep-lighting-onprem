import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "./layout/AppLayout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import NotFound from "./pages/NotFound.jsx";

const History = lazy(() => import("./pages/History.jsx"));
const Illuminance = lazy(() => import("./pages/Illuminance.jsx"));
const Settings = lazy(() => import("./pages/Settings.jsx"));

function PageFallback() {
  return (
    <div className="text-sm text-[var(--color-text-muted)]">불러오는 중…</div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route
          path="history"
          element={
            <Suspense fallback={<PageFallback />}>
              <History />
            </Suspense>
          }
        />
        <Route
          path="illuminance"
          element={
            <Suspense fallback={<PageFallback />}>
              <Illuminance />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<PageFallback />}>
              <Settings />
            </Suspense>
          }
        />
        <Route path="404" element={<NotFound />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Route>
    </Routes>
  );
}
