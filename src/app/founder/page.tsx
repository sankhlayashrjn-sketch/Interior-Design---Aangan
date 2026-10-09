import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { FlagChip } from "@/components/Chip";
import type { CallStatus } from "@/db/schema";
import { getDetail } from "@/lib/calls";
import { costPanel, founderList, founderMetrics, parseRange, RANGES, statusCounts } from "@/lib/founder";
import { fmtInr, fmtMinutes, fmtWhen } from "@/lib/format";

const TABS: { key: CallStatus; label: string }[] = [
  { key: "qualified", label: "Qualified" },
  { key: "disqualified", label: "Disqualified" },
  { key: "needs_attention", label: "Needs attention" },
  { key: "yet_to_be_processed", label: "Yet to be processed" },
];

const ROW = "grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_2.5rem_7.5rem_minmax(0,1.3fr)]";

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-small text-mute">{label}</dt>
      <dd className="mt-1 text-title font-medium tabular-nums">{value}</dd>
      {sub && <dd className="text-small text-mute">{sub}</dd>}
    </div>
  );
}

export default async function FounderPage({ searchParams }: { searchParams: Promise<{ tab?: string; range?: string; call?: string }> }) {
  const sp = await searchParams;
  const now = new Date();
  const range = parseRange(sp.range);
  const tab: CallStatus = TABS.some((t) => t.key === sp.tab) ? (sp.tab as CallStatus) : "qualified";
  const m = founderMetrics(range, now);
  const cost = costPanel(range, now);
  const counts = statusCounts();
  const rows = founderList(tab);
  const selectedId = Number(sp.call) || null;
  const detail = selectedId ? getDetail(selectedId) : null;
  const rangeLabel = RANGES.find((r) => r.key === range)!.label.toLowerCase();
  const q = (over: Record<string, string>) => `/founder?${new URLSearchParams({ tab, range, ...over }).toString()}`;

  return (
    <div>
      <AutoRefresh />
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-title font-medium">Founder view</h1>
        <nav aria-label="Period" className="flex gap-4 text-small">
          {RANGES.map((r) => (
            <Link key={r.key} href={q({ range: r.key, call: "" })} aria-current={r.key === range ? "true" : undefined} className={r.key === range ? "font-medium text-ink underline underline-offset-4" : "text-mute hover:text-ink"}>
              {r.label}
            </Link>
          ))}
        </nav>
      </div>

      <section aria-label="Metrics">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Calls today" value={String(m.callsToday)} sub={`${m.callsInRange} in the last ${rangeLabel}`} />
          <Metric label="Acknowledged within SLA" value={m.sla.pct === null ? "–" : `${m.sla.pct}%`} sub={m.sla.total ? `${m.sla.met} of ${m.sla.total} judged` : "nothing due yet"} />
          <Metric label="After-hours calls caught" value={String(m.afterHours.count)} sub={`${m.afterHours.acknowledged} acknowledged`} />
          <Metric label="Avg time to acknowledge" value={m.avgAckMinutes === null ? "–" : fmtMinutes(m.avgAckMinutes)} sub={m.ackCount ? `working time, ${m.ackCount} calls` : "no acknowledgements yet"} />
          <Metric label="Calls with a booked slot" value={String(m.booked)} />
        </dl>
      </section>

      <section aria-label="Cost" className="mt-8">
        <h2 className="mb-3 text-small font-medium text-mute">Cost</h2>
        <table className="w-full max-w-3xl text-left">
          <thead className="sr-only">
            <tr>
              <th>Measure</th>
              <th>Value</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["AI cost per call", cost.perCall ? fmtInr(cost.perCall.ai, 4) : "–", cost.perCall ? `average of ${cost.perCall.calls} calls, last ${rangeLabel}` : "no calls"],
              ["Telephony per call", cost.perCall ? `${cost.perCall.telephonyMinutes.toFixed(1)} min, ${fmtInr(cost.perCall.telephony)}` : "–", cost.perCall ? `average, last ${rangeLabel}` : "no calls"],
              [`Total for ${cost.month.label}`, fmtInr(cost.month.total), `${cost.month.calls} calls: AI ${fmtInr(cost.month.ai)}, telephony ${fmtInr(cost.month.telephony)}`],
              ["Cost per qualified lead", cost.month.perQualified === null ? "–" : fmtInr(cost.month.perQualified), cost.month.qualified ? `${cost.month.qualified} qualified in ${cost.month.label}` : `no qualified calls in ${cost.month.label}`],
            ].map(([label, value, basis]) => (
              <tr key={label} className="border-t border-line align-baseline first:border-t-0">
                <td className="py-2 pr-6">{label}</td>
                <td className="py-2 pr-6 font-medium tabular-nums">{value}</td>
                <td className="py-2 text-small text-mute">{basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cost.estimated && <p className="mt-2 text-small text-mute">Some AI costs are estimates from mock mode (token counts guessed from text length). Live mode records the real usage.</p>}
      </section>

      <div className="mt-10 grid gap-10 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className={detail ? "hidden xl:block" : ""} aria-label="Calls">
          <div role="tablist" aria-label="Call lists" className="mb-2 flex flex-wrap gap-x-6 border-b border-line">
            {TABS.map((t) => (
              <Link key={t.key} href={q({ tab: t.key, call: "" })} role="tab" aria-selected={t.key === tab} className={`-mb-px border-b-2 py-2 ${t.key === tab ? "border-ink font-medium" : "border-transparent text-mute hover:text-ink"}`}>
                {t.label} <span className="text-small text-mute">{counts[t.key]}</span>
              </Link>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="py-8 text-mute">No calls here.</p>
          ) : (
            <>
              <div className={`${ROW} hidden border-b border-line py-2 text-small text-mute sm:grid`} aria-hidden="true">
                <span>Time</span>
                <span>Caller</span>
                <span>Score</span>
                <span>Designer</span>
                <span>{tab === "disqualified" || tab === "needs_attention" ? "Reason" : tab === "qualified" ? "Booked / acknowledged" : "Status"}</span>
              </div>
              <ul>
                {rows.map((c) => {
                  const note =
                    tab === "disqualified" || tab === "needs_attention"
                      ? (c.reason ?? "")
                      : tab === "qualified"
                        ? [c.bookedSlot && c.bookingStatus !== "cancelled" ? `Booked ${fmtWhen(c.bookedSlot, now)}` : null, c.acknowledgedAt ? "Acknowledged" : "Waiting"].filter(Boolean).join(" · ")
                        : "Processing";
                  return (
                    <li key={c.id} className="border-b border-line">
                      <Link href={q({ call: String(c.id) })} aria-current={c.id === selectedId ? "true" : undefined} className={`${ROW} items-baseline py-3 ${c.id === selectedId ? "bg-[#f1f1ee]" : "hover:bg-[#f5f5f3]"}`}>
                        <span className="text-small text-mute">{fmtWhen(c.startedAt, now)}</span>
                        <span className="col-start-1 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
                          <span className="block truncate font-medium">{c.callerName ?? c.callerPhone ?? "Unknown caller"}</span>
                          <span className="block truncate text-small text-mute">{c.callerName ? (c.callerPhone ?? "Caller ID withheld") : (c.location ?? "")}</span>
                        </span>
                        <span className="tabular-nums">{c.score ?? "–"}</span>
                        <span className="col-span-2 flex flex-wrap items-center gap-1 sm:col-span-1">
                          <span className="truncate text-small">{c.designerName ?? "Nobody"}</span>
                          <FlagChip flag={c.flag} />
                        </span>
                        <span className="col-span-2 text-small text-mute sm:col-span-1">{note}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <aside className={detail ? "" : "hidden xl:block"} aria-label="Selected call">
          {detail ? <CallDetail detail={detail} backHref={q({ call: "" })} now={now} /> : <p className="py-8 text-mute">Select a call to see the handoff note and why it was scored that way.</p>}
        </aside>
      </div>
    </div>
  );
}
