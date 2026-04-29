import { useQuery } from "@tanstack/react-query";
import { illuminanceApi } from "../api";

export function useCurrentIlluminance({ refetchMs = 5000 } = {}) {
  return useQuery({
    queryKey: ["illuminance", "current"],
    queryFn: () => illuminanceApi.getCurrent(),
    refetchInterval: refetchMs,
    retry: (count, err) => err?.status !== 404 && count < 2,
  });
}

export function useIlluminanceHistory(hours = 24) {
  return useQuery({
    queryKey: ["illuminance", "history", hours],
    queryFn: () => illuminanceApi.getHistory(hours),
    refetchInterval: 30_000,
  });
}
