import { useQuery } from "@tanstack/react-query";
import { statusApi } from "../api";

export function useHealth() {
  return useQuery({
    queryKey: ["status", "health"],
    queryFn: () => statusApi.health(),
    refetchInterval: 30_000,
  });
}

export function useFitbitStatus() {
  return useQuery({
    queryKey: ["status", "fitbit"],
    queryFn: () => statusApi.fitbit(),
    refetchInterval: 60_000,
  });
}

export function useDeviceStatus() {
  return useQuery({
    queryKey: ["status", "device"],
    queryFn: () => statusApi.device(),
    refetchInterval: 15_000,
  });
}
