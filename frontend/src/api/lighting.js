import { apiClient } from "./client";

export const lightingApi = {
  runRoutine: (payload) => apiClient.post("/api/lighting/routine", payload),
};
