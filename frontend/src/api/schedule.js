import { apiClient } from "./client";

export const scheduleApi = {
  get: () => apiClient.get("/api/schedule"),
  save: (payload) => apiClient.post("/api/schedule", payload),
  remove: () => apiClient.delete("/api/schedule"),
};
