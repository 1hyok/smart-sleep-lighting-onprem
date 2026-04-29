import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "../api";

export function useReportByDate(date) {
  return useQuery({
    queryKey: ["reports", "byDate", date],
    queryFn: () => reportsApi.getByDate(date),
    enabled: !!date,
    retry: (count, err) => err?.status !== 404 && count < 2,
  });
}

export function useRecentReports(days = 7) {
  return useQuery({
    queryKey: ["reports", "recent", days],
    queryFn: () => reportsApi.getRecent(days),
  });
}
