import { apiClient } from "./client";

export const reportsApi = {
  getByDate: (date) => apiClient.get(`/api/reports?date=${date}`),
  getRecent: (days = 7) => apiClient.get(`/api/reports/recent?days=${days}`),
};
