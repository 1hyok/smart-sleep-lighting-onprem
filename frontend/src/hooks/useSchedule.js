import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scheduleApi } from "../api";

const KEY = ["schedule"];

export function useSchedule() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => scheduleApi.get(),
    retry: (count, err) => err?.status !== 404 && count < 2,
  });
}

export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => scheduleApi.save(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => scheduleApi.remove(),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
