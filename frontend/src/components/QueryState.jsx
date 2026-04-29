export default function QueryState({ query, empty = "데이터가 없습니다.", children }) {
  if (query.isLoading) {
    return <div className="text-sm text-[var(--color-text-muted)]">불러오는 중…</div>;
  }
  if (query.isError) {
    if (query.error?.status === 404) {
      return <div className="text-sm text-[var(--color-text-muted)]">{empty}</div>;
    }
    return (
      <div className="text-sm text-[var(--color-danger)]">
        오류: {query.error?.message ?? "알 수 없는 오류"}
      </div>
    );
  }
  return children;
}
