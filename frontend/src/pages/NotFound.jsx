import { Link } from "react-router-dom";
import Card from "../components/Card.jsx";

export default function NotFound() {
  return (
    <Card title="404">
      <p className="text-sm text-[var(--color-text-muted)] mb-3">
        존재하지 않는 페이지입니다.
      </p>
      <Link to="/" className="text-[var(--color-accent)] text-sm hover:underline">
        대시보드로 돌아가기
      </Link>
    </Card>
  );
}
