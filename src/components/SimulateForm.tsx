"use client";

import { useActionState, useState } from "react";
import { openAs, simulateAction, type SimulateState } from "@/app/actions";
import { StatusChip } from "@/components/Chip";

export interface SampleOption {
  id: string;
  title: string;
  expected: string;
  transcript: string;
  durationSec: number;
}

interface Props {
  samples: SampleOption[];
  today: string; // YYYY-MM-DD in IST
  nextSunday: string;
  nowTime: string; // HH:mm in IST
}

const field = "mt-1 w-full rounded border border-line bg-paper px-2 py-1.5";
const label = "block text-small text-mute";

export function SimulateForm({ samples, today, nextSunday, nowTime }: Props) {
  const [state, action, pending] = useActionState<SimulateState, FormData>(simulateAction, {});
  const [sampleId, setSampleId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [duration, setDuration] = useState(180);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState(nowTime);
  const [withheld, setWithheld] = useState(false);

  function pick(id: string) {
    setSampleId(id);
    const s = samples.find((x) => x.id === id);
    if (s) {
      setTranscript(s.transcript);
      setDuration(s.durationSec);
    }
  }

  const preset = (d: string, t: string) => () => {
    setDate(d);
    setTime(t);
  };
  const quick = "rounded border border-line px-2 py-1 text-small hover:border-ink";

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-5">
              <label htmlFor="sample" className={label}>
              Sample call
            </label>
            <select id="sample" value={sampleId} onChange={(e) => pick(e.target.value)} className={field}>
              <option value="">Paste your own transcript below</option>
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.title}
                </option>
              ))}
            </select>
        </div>

        <form action={action} className="space-y-5">
        <div>
          <label htmlFor="transcript" className={label}>
            Transcript (one line per turn, starting "Agent:" or "Caller:")
          </label>
          <textarea id="transcript" name="transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={12} className={`${field} font-[inherit]`} />
        </div>

        <fieldset>
          <legend className={label}>When the call came in (IST)</legend>
          <input type="hidden" name="startedAt" value={`${date}T${time}`} />
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <input type="date" aria-label="Call date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-line bg-paper px-2 py-1.5" />
            <input type="time" aria-label="Call time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded border border-line bg-paper px-2 py-1.5" />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={quick} onClick={preset(today, nowTime)}>
              Now
            </button>
            <button type="button" className={quick} onClick={preset(today, "11:00")}>
              Working hours, 11:00
            </button>
            <button type="button" className={quick} onClick={preset(today, "17:30")}>
              Late afternoon, 17:30
            </button>
            <button type="button" className={quick} onClick={preset(today, "21:30")}>
              After hours, 21:30
            </button>
            <button type="button" className={quick} onClick={preset(nextSunday, "14:00")}>
              Sunday, 14:00
            </button>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="phone" className={label}>
              Caller ID
            </label>
            <input id="phone" name="phone" defaultValue="98765 43210" disabled={withheld} className={`${field} disabled:opacity-50`} />
            <label className="mt-2 flex items-center gap-2 text-small">
              <input type="checkbox" name="withheld" checked={withheld} onChange={(e) => setWithheld(e.target.checked)} />
              Withhold caller ID
            </label>
          </div>
          <div>
            <label htmlFor="duration" className={label}>
              Call length (seconds)
            </label>
            <input id="duration" name="duration" type="number" min={0} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={field} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="bookedSlot" className={label}>
              Booked consultation slot (optional, IST)
            </label>
            <input id="bookedSlot" name="bookedSlot" type="datetime-local" className="mt-1 rounded border border-line bg-paper px-2 py-1.5" />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button type="submit" disabled={pending} className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
            {pending ? "Processing" : "Simulate call"}
          </button>
          {state.error && (
            <p role="alert" className="font-medium">
              {state.error}
            </p>
          )}
        </div>
      </form>
      </div>

      <aside aria-live="polite" aria-label="Result">
        {state.result ? (
          <div>
            <h2 className="mb-3 text-small font-medium text-mute">Result</h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={state.result.status} />
              <span className="tabular-nums">{state.result.score !== null ? `${state.result.score} / 100` : "Not scored"}</span>
            </div>
            {state.result.reason && <p className="mt-3">{state.result.reason}</p>}
            <p className="mt-3 text-mute">
              Assigned to {state.result.designerName ?? "nobody"}
              {state.result.afterHours ? ". Arrived after hours, so it goes in that designer's 09:00 digest." : "."}
              {state.result.duplicate ? " Duplicate external ID: nothing new was created." : ""}
            </p>
            {state.result.designerId && (
              <form action={openAs} className="mt-4">
                <input type="hidden" name="designerId" value={state.result.designerId} />
                <input type="hidden" name="callId" value={state.result.id} />
                <button type="submit" className="rounded border border-ink px-3 py-1.5 font-medium">
                  Open in dashboard as {state.result.designerName}
                </button>
              </form>
            )}
          </div>
        ) : (
          <p className="text-mute">Pick a sample or paste a transcript, choose when it arrived, and run it through the same pipeline a real call uses.</p>
        )}
      </aside>
    </div>
  );
}
