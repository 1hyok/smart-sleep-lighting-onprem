import { apiClient } from "./client";

export const statusApi = {
  health: () => apiClient.get("/api/health"),
  fitbit: () => apiClient.get("/api/fitbit/status"),
  device: () => apiClient.get("/api/device/status"),
};
