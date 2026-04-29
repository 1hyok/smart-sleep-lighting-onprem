import { useState } from "react";
import Card from "../components/Card.jsx";
import QueryState from "../components/QueryState.jsx";
import Button from "../components/Button.jsx";
import { Field, TimeInput, NumberInput, Checkbox } from "../components/Field.jsx";
import {
  useDeleteSchedule,
  useSaveSchedule,
  useSchedule,
} from "../hooks/useSchedule.js";
import { useFitbitStatus } from "../hooks/useStatus.js";
import { formatTimeShort } from "../lib/format.js";

const DEFAULT_FORM = {
  sleepTime: "23:00",
  wakeTime: "07:00",
  sleepOffsetMin: 30,
  wakeOffsetMin: 15,
  enabled: true,
};

const TIME_RE = /^\d{2}:\d{2}$/;

function validate(form) {
  const errors = {};
  if (!TIME_RE.test(form.sleepTime)) errors.sleepTime = "HH:MM 형식이어야 합니다.";
  if (!TIME_RE.test(form.wakeTime)) errors.wakeTime = "HH:MM 형식이어야 합니다.";
  if (form.sleepTime === form.wakeTime) {
    errors.wakeTime = "취침과 기상 시각이 같을 수 없습니다.";
  }
  if (
    !Number.isFinite(form.sleepOffsetMin) ||
    form.sleepOffsetMin < 0 ||
    form.sleepOffsetMin > 240
  ) {
    errors.sleepOffsetMin = "0 ~ 240 사이 정수여야 합니다.";
  }
  if (
    !Number.isFinite(form.wakeOffsetMin) ||
    form.wakeOffsetMin < 0 ||
    form.wakeOffsetMin > 240
  ) {
    errors.wakeOffsetMin = "0 ~ 240 사이 정수여야 합니다.";
  }
  return errors;
}

function fromServer(data) {
  if (!data) return DEFAULT_FORM;
  return {
    sleepTime: data.sleepTime ?? DEFAULT_FORM.sleepTime,
    wakeTime: data.wakeTime ?? DEFAULT_FORM.wakeTime,
    sleepOffsetMin: data.sleepOffsetMin ?? DEFAULT_FORM.sleepOffsetMin,
    wakeOffsetMin: data.wakeOffsetMin ?? DEFAULT_FORM.wakeOffsetMin,
    enabled: data.enabled ?? DEFAULT_FORM.enabled,
  };
}

export default function Settings() {
  const schedule = useSchedule();

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FitbitCard />
      <Card title="취침/기상 스케줄" className="md:col-span-2">
        {schedule.isLoading ? (
          <div className="text-sm text-[var(--color-text-muted)]">불러오는 중…</div>
        ) : schedule.isError && schedule.error?.status !== 404 ? (
          <div className="text-sm text-[var(--color-danger)]">
            오류: {schedule.error?.message}
          </div>
        ) : (
          <ScheduleForm
            key={schedule.data?.id ?? "new"}
            saved={schedule.data}
          />
        )}
      </Card>
    </div>
  );
}

function ScheduleForm({ saved }) {
  const saveMutation = useSaveSchedule();
  const deleteMutation = useDeleteSchedule();
  const [form, setForm] = useState(() => fromServer(saved));
  const [errors, setErrors] = useState({});
  const [submitMessage, setSubmitMessage] = useState(null);

  function patch(p) {
    setForm((prev) => ({ ...prev, ...p }));
    setSubmitMessage(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const v = validate(form);
    setErrors(v);
    if (Object.keys(v).length > 0) return;

    try {
      const result = await saveMutation.mutateAsync({
        sleepTime: form.sleepTime,
        wakeTime: form.wakeTime,
        sleepOffsetMin: form.sleepOffsetMin,
        wakeOffsetMin: form.wakeOffsetMin,
        enabled: form.enabled,
      });
      setSubmitMessage({
        tone: "ok",
        text: result?.message ?? "저장되었습니다.",
      });
    } catch (err) {
      setSubmitMessage({
        tone: "danger",
        text: err?.message ?? "저장에 실패했습니다.",
      });
    }
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      "현재 저장된 스케줄을 삭제할까요? 자동 조명 루틴이 비활성화됩니다.",
    );
    if (!confirmed) return;
    try {
      await deleteMutation.mutateAsync();
      setForm(DEFAULT_FORM);
      setErrors({});
      setSubmitMessage({ tone: "ok", text: "스케줄이 삭제되었습니다." });
    } catch (err) {
      setSubmitMessage({
        tone: "danger",
        text: err?.message ?? "삭제에 실패했습니다.",
      });
    }
  }

  const saving = saveMutation.isPending;
  const deleting = deleteMutation.isPending;
  const hasSavedSchedule = !!saved?.id;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="취침 시각" error={errors.sleepTime}>
          <TimeInput
            value={form.sleepTime}
            onChange={(e) => patch({ sleepTime: e.target.value })}
            required
          />
        </Field>
        <Field label="기상 시각" error={errors.wakeTime}>
          <TimeInput
            value={form.wakeTime}
            onChange={(e) => patch({ wakeTime: e.target.value })}
            required
          />
        </Field>
        <Field
          label="취침 오프셋 (분 전부터 소등 시작)"
          hint="기본 30분"
          error={errors.sleepOffsetMin}
        >
          <NumberInput
            min={0}
            max={240}
            value={form.sleepOffsetMin}
            onChange={(e) =>
              patch({ sleepOffsetMin: parseInt(e.target.value, 10) })
            }
          />
        </Field>
        <Field
          label="기상 오프셋 (분 전부터 점등 시작)"
          hint="기본 15분"
          error={errors.wakeOffsetMin}
        >
          <NumberInput
            min={0}
            max={240}
            value={form.wakeOffsetMin}
            onChange={(e) =>
              patch({ wakeOffsetMin: parseInt(e.target.value, 10) })
            }
          />
        </Field>
      </div>

      <Checkbox
        checked={form.enabled}
        onChange={(v) => patch({ enabled: v })}
        label="자동 루틴 활성화"
      />

      {submitMessage && (
        <div
          className={
            submitMessage.tone === "ok"
              ? "text-xs text-[var(--color-accent-2)]"
              : "text-xs text-[var(--color-danger)]"
          }
        >
          {submitMessage.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button type="submit" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={!hasSavedSchedule || deleting}
          onClick={handleDelete}
        >
          {deleting ? "삭제 중…" : "스케줄 삭제"}
        </Button>
      </div>

      {hasSavedSchedule && (
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
          <div>
            마지막 취침 트리거 ·{" "}
            {saved.lastSleepTriggered
              ? formatTimeShort(saved.lastSleepTriggered)
              : "기록 없음"}
          </div>
          <div>
            마지막 기상 트리거 ·{" "}
            {saved.lastWakeTriggered
              ? formatTimeShort(saved.lastWakeTriggered)
              : "기록 없음"}
          </div>
        </div>
      )}
    </form>
  );
}

function FitbitCard() {
  const fitbit = useFitbitStatus();

  return (
    <Card title="Fitbit 연동">
      <QueryState query={fitbit} empty="Fitbit 상태를 가져올 수 없습니다.">
        <FitbitBody data={fitbit.data} />
      </QueryState>
    </Card>
  );
}

function FitbitBody({ data }) {
  if (!data) return null;
  const tone =
    data.status === "connected"
      ? "text-[var(--color-accent-2)]"
      : data.status === "expired"
        ? "text-[var(--color-warn)]"
        : "text-[var(--color-danger)]";

  return (
    <div className="space-y-2 text-sm">
      <div>
        상태 · <span className={tone}>{data.status}</span>
      </div>
      {data.message && (
        <div className="text-xs text-[var(--color-text-muted)]">
          {data.message}
        </div>
      )}
      {data.lastSyncAt && (
        <div className="text-xs text-[var(--color-text-muted)]">
          마지막 동기화: {formatTimeShort(data.lastSyncAt)}
        </div>
      )}
      {data.expiresAt && (
        <div className="text-xs text-[var(--color-text-muted)]">
          토큰 만료: {new Date(data.expiresAt).toLocaleString("ko-KR")}
        </div>
      )}
    </div>
  );
}
