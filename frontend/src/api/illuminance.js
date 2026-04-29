import { apiClient } from "./client";

export const illuminanceApi = {
  getCurrent: () => apiClient.get("/api/illuminance/current"),
  getHistory: (hours = 24) => apiClient.get(`/api/illuminance/history?hours=${hours}`),
};
