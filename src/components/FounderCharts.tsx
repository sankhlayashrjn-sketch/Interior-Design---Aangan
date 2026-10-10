import type { DesignerLoad, FunnelStep, TrendDay } from "@/lib/founder";
import { fmtMinutes } from "@/lib/format";

/**
 * Calls per day. Dark = qualified, grey = every other call. Plain HTML bars, so it needs no chart library
 * and reads on a phone. A hidden table below carries the same numbers for screen readers.
 */
export function TrendChart({ days }: { days: TrendDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  const every = days.length > 14 ? 5 : 1; // label every 5th day on the 30-day view
  const total = days.reduce((s, d) => s + d.total, 0);
  if (total === 0) return <p className="py-4 text-mute">No calls in this period yet.</p>;
  return (
    <figure>
      <div className="flex h-28 items-end gap-1" role="img" aria-label={`Calls per day, ${days[0].label} to ${days.at(-1)!.label}. ${total} calls in total.`}>
        {days.map((d) => {
          const other = d.total - d.qualified;
          return (
            <div key={d.date} className="flex h-full flex-1 flex-col justify-end" title={`${d.label}: ${d.total} ${d.total === 1 ? "call" : "calls"}, ${d.qualified} qualified`}>
              {other > 0 && <div className="bg-[#454b53]" style={{ height: `${(other / max) * 100}%` }} />}
              {d.qualified > 0 && <div className="bg-accent" style={{ height: `${(d.qualified / max) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.date} className="flex-1 overflow-visible whitespace-nowrap text-center text-small text-mute">
            {i % every === 0 ? d.label.replace(/^\w+ /, "") : ""}
          </span>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 text-small text-mute">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 bg-accent" /> Qualified
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 bg-[#454b53]" /> Other calls
        </span>
        <span>Busiest day: {Math.max(...days.map((d) => d.total))}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Calls per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Calls</th>
            <th>Qualified</th>
            <th>Needs attention</th>
            <th>Disqualified</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{d.label}</td>
              <td>{d.total}</td>
              <td>{d.qualified}</td>
              <td>{d.needsAttention}</td>
              <td>{d.disqualified}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function FunnelList({ steps }: { steps: FunnelStep[] }) {
  return (
    <ul className="max-w-2xl">
      {steps.map((s) => (
        <li key={s.label} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-baseline gap-x-4 gap-y-1 border-t border-line py-2 first:border-t-0 sm:grid-cols-[14rem_6rem_minmax(0,1fr)]">
          <span>{s.label}</span>
          <span className="text-right tabular-nums sm:text-left">
            <span className="font-medium">{s.count}</span> <span className="text-small text-mute">{s.pct === null ? "" : `${s.pct}%`}</span>
          </span>
          <span className="col-span-2 h-1.5 bg-well sm:col-span-1" aria-hidden="true">
            <span className="block h-full bg-accent" style={{ width: `${s.pct ?? 0}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DesignerTable({ rows }: { rows: DesignerLoad[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left">
        <thead>
          <tr className="border-b border-line text-small text-mute">
            <th className="py-2 pr-4 font-normal">Designer</th>
            <th className="py-2 pr-4 text-right font-normal">Assigned</th>
            <th className="py-2 pr-4 text-right font-normal">Waiting</th>
            <th className="py-2 pr-4 text-right font-normal">Overdue</th>
            <th className="py-2 pr-4 text-right font-normal">On time</th>
            <th className="py-2 text-right font-normal">Avg to acknowledge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-b border-line">
              <td className="py-2 pr-4">
                {d.name}
                {d.isEscalation && <span className="text-small text-mute"> · studio head</span>}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{d.assigned}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{d.waiting}</td>
              <td className={`py-2 pr-4 text-right tabular-nums ${d.overdue > 0 ? "font-medium text-accent" : ""}`}>{d.overdue}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{d.onTimePct === null ? "–" : `${d.onTimePct}%`}</td>
              <td className="py-2 text-right tabular-nums">{d.avgAckMinutes === null ? "–" : fmtMinutes(d.avgAckMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
