import Card from "../components/Card.jsx";

export default function Illuminance() {
  return (
    <Card title="조도 모니터링">
      <p className="text-sm text-[var(--color-text-muted)]">
        실시간 조도와 24시간 그래프가 들어갈 자리입니다.
      </p>
    </Card>
  );
}
