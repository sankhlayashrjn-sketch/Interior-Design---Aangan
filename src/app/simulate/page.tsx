import { DateTime } from "luxon";
import { PageBanner } from "@/components/memphis/PageBanner";
import { SimulateForm } from "@/components/SimulateForm";
import samples from "@/seed/sample-calls.json";
import { SAMPLE_TITLES } from "@/seed/sample-titles";
import { IST } from "@/lib/working-hours";

export default function SimulatePage() {
  const now = DateTime.now().setZone(IST);
  const daysToSunday = (7 - (now.weekday % 7)) % 7 || 7;
  return (
    <div>
      <PageBanner title="Simulate call" tone="teal" subtitle="Run a transcript through the same pipeline as a real call" />
      <SimulateForm
        samples={samples.map((s) => ({ id: s.id, title: SAMPLE_TITLES[s.id] ?? s.label, expected: s.expected, transcript: s.transcript, durationSec: s.durationSec }))}
        today={now.toISODate()!}
        nextSunday={now.plus({ days: daysToSunday }).toISODate()!}
        nowTime={now.toFormat("HH:mm")}
      />
    </div>
  );
}
