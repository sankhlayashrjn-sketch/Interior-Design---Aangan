import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { FlagChip, StatusChip } from "@/components/Chip";
import { FilterBar, hasFilters, type Filters } from "@/components/FilterBar";
import { countsForDesigner, getDetail, listForDesigner, todayForDesigner, type SortKey, type Tab } from "@/lib/calls";
import { fmtDue, fmtWhen } from "@/lib/format";
import { currentDesigner } from "@/lib/session";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pending acknowledgement" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "all", label: "All" },
];

const ROW = "grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_2.5rem_8.75rem_5.5rem_8rem]";

const SORTS: SortKey[] = ["priority", "newest", "due", "score"];
const STATUSES = ["qualified", "needs_attention", "disqualified"];

type Params = { tab?: string; call?: string; q?: string; status?: string; sort?: string; booked?: string; overdue?: string; afterHours?: string };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const me = await currentDesigner();
  if (!me) return <p className="text-mute">No designers yet. Run the seed script or add one in Settings.</p>;

  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : "pending";
  const now = new Date();
  const filters: Filters = {
    q: (sp.q ?? "").slice(0, 100),
    status: STATUSES.includes(sp.status ?? "") ? sp.status! : "",
    sort: SORTS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "",
    booked: sp.booked === "1",
    overdue: sp.overdue === "1",
    afterHours: sp.afterHours === "1",
  };
  const rows = await listForDesigner(me.id, tab, now, {
    q: filters.q,
    status: (filters.status || undefined) as never,
    sort: filters.sort || undefined,
    booked: filters.booked,
    overdue: filters.overdue,
    afterHours: filters.afterHours,
  });
  const counts = await countsForDesigner(me.id);
  const today = await todayForDesigner(me.id, now);
  // Links keep the current search and filters, so moving between tabs or opening a call does not lose them.
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries({ q: filters.q, status: filters.status, sort: filters.sort, booked: filters.booked ? "1" : "", overdue: filters.overdue ? "1" : "", afterHours: filters.afterHours ? "1" : "" })) if (v) keep.set(k, v);
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(over)) v ? p.set(k, v) : p.delete(k);
    return `/?${p.toString()}`;
  };
  const selectedId = Number(sp.call) || null;
  const detail = selectedId ? await getDetail(selectedId) : null;
  const listHref = href({ tab, call: "" });

  return (
    <div>
      <AutoRefresh />
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-medium">{me.name}</h1>
        <p className="text-small text-mute">{counts.pending} waiting for you</p>
      </div>

      <p className="mb-6 flex flex-wrap gap-x-5 gap-y-1 text-small" aria-label="Today">
        <Link href="/?tab=pending&overdue=1" className={today.overdue > 0 ? "font-medium text-accent" : "text-mute"}>
          Overdue {today.overdue}
        </Link>
        <span className="text-mute">Due within the hour {today.dueSoon}</span>
        <Link href="/?tab=all&booked=1" className="text-mute hover:text-ink">
          Booked today {today.bookedToday}
        </Link>
        <Link href="/?tab=pending&afterHours=1" className="text-mute hover:text-ink">
          Waiting from after hours {today.afterHoursWaiting}
        </Link>
      </p>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className={detail ? "hidden xl:block" : ""} aria-label="Calls">
          <div role="tablist" aria-label="Call lists" className="mb-2 flex flex-wrap gap-x-6 border-b border-line">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={href({ tab: t.key, call: "" })}
                role="tab"
                aria-selected={t.key === tab}
                className={`-mb-px border-b-2 py-2 ${t.key === tab ? "border-ink font-medium" : "border-transparent text-mute hover:text-ink"}`}
              >
                {t.label} <span className="text-small text-mute">{counts[t.key]}</span>
              </Link>
            ))}
          </div>

          <FilterBar tab={tab} filters={filters} />

          {rows.length === 0 ? (
            <p className="py-8 text-mute">{hasFilters(filters) ? "No calls match these filters." : tab === "pending" ? "Nothing is waiting for you." : "No calls here yet."}</p>
          ) : (
            <>
              <div className={`${ROW} hidden border-b border-line py-2 text-small text-mute sm:grid`} aria-hidden="true">
                <span>Time</span>
                <span>Caller</span>
                <span>Score</span>
                <span>Status</span>
                <span>Booked</span>
                <span>Due</span>
              </div>
              <ul>
                {rows.map((c) => {
                  const due = fmtDue(c.dueAt, c.acknowledgedAt, now);
                  const active = c.id === selectedId;
                  return (
                    <li key={c.id} className="border-b border-line">
                      <Link
                        href={href({ tab, call: String(c.id) })}
                        aria-current={active ? "true" : undefined}
                        className={`${ROW} items-baseline py-3 ${active ? "bg-[#f1f1ee]" : "hover:bg-[#f5f5f3]"}`}
                      >
                        <span className="text-small text-mute">{fmtWhen(c.startedAt, now)}</span>
                        <span className="col-start-1 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
                          <span className="block truncate font-medium">{c.callerName ?? c.callerPhone ?? "Unknown caller"}</span>
                          <span className="block truncate text-small text-mute">{c.callerName ? (c.callerPhone ?? "Caller ID withheld") : c.location ?? ""}</span>
                        </span>
                        <span className="tabular-nums sm:text-left">{c.score ?? "–"}</span>
                        <span className="col-span-2 flex flex-wrap items-center gap-1 sm:col-span-1">
                          <StatusChip status={c.status} />
                          <FlagChip flag={c.flag} />
                        </span>
                        <span className={`text-small text-mute ${c.bookedSlot ? "" : "hidden sm:block"}`}>
                          {c.bookedSlot && c.bookingStatus !== "cancelled" ? fmtWhen(c.bookedSlot, now) : c.bookingStatus === "cancelled" ? "Cancelled" : "–"}
                        </span>
                        <span className={`text-small ${due.state === "overdue" ? "font-medium text-accent" : "text-mute"}`}>{due.text}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <aside className={detail ? "" : "hidden xl:block"} aria-label="Selected call">
          {detail ? <CallDetail detail={detail} backHref={listHref} now={now} /> : <p className="py-8 text-mute">Select a call to read the handoff note.</p>}
        </aside>
      </div>
    </div>
  );
}
