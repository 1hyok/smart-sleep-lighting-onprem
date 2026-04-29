import Card from "../components/Card.jsx";

export default function Settings() {
  return (
    <Card title="설정">
      <p className="text-sm text-[var(--color-text-muted)]">
        취침/기상 시각, 오프셋, Fitbit 연동 상태가 들어갈 자리입니다.
      </p>
    </Card>
  );
}
