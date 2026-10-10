import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { ackCell, CallList } from "@/components/CallList";
import { FilterBar, hasFilters, type Filters } from "@/components/FilterBar";
import { activeDesigners, countsForDesigner, getDetail, listForDesigner, todayForDesigner, type SortKey, type Tab } from "@/lib/calls";
import { currentDesigner } from "@/lib/session";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "Pending acknowledgement" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "all", label: "All" },
];

const SORTS: SortKey[] = ["priority", "newest", "due", "score"];
const STATUSES = ["qualified", "needs_attention", "disqualified"];

type Params = { tab?: string; who?: string; open?: string; q?: string; status?: string; sort?: string; booked?: string; overdue?: string; afterHours?: string };

/** Designers audit the calls assigned to them: open a call to read the handoff note, the score and the full transcript, then acknowledge it. */
export default async function Designers({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const designers = (await activeDesigners()).filter((d) => d.role === "designer");
  if (designers.length === 0) return <p className="text-mute">No designers yet. Add one in Settings.</p>;

  // A designer sees their own calls by default; anyone else (front desk, founder) sees everyone's.
  const me = await currentDesigner();
  const picked = sp.who === "all" ? "all" : designers.find((d) => String(d.id) === sp.who)?.id;
  const who: number | "all" = picked ?? (me?.role === "designer" ? me.id : "all");
  const whoName = who === "all" ? "All designers" : designers.find((d) => d.id === who)!.name;
  const names = new Map(designers.map((d) => [d.id, d.name]));

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
  const rows = await listForDesigner(who, tab, now, {
    q: filters.q,
    status: (filters.status || undefined) as never,
    sort: filters.sort || undefined,
    booked: filters.booked,
    overdue: filters.overdue,
    afterHours: filters.afterHours,
  });
  const counts = await countsForDesigner(who);
  const today = await todayForDesigner(who, now);

  const whoParam = String(who);
  const keep = new URLSearchParams({ who: whoParam });
  for (const [k, v] of Object.entries({ q: filters.q, status: filters.status, sort: filters.sort, booked: filters.booked ? "1" : "", overdue: filters.overdue ? "1" : "", afterHours: filters.afterHours ? "1" : "" })) if (v) keep.set(k, v);
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(over)) v ? p.set(k, v) : p.delete(k);
    return `/designers?${p.toString()}`;
  };

  const openId = Number(sp.open) || null;
  const detail = openId ? await getDetail(openId) : null;

  return (
    <div>
      <AutoRefresh />
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-title font-medium">{whoName}</h1>
        <p className="text-small text-mute">{counts.pending} waiting for acknowledgement</p>
      </div>

      <nav aria-label="Designer" className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-small">
        {[{ id: "all" as const, name: "Everyone" }, ...designers].map((d) => (
          <Link key={d.id} href={`/designers?who=${d.id}&tab=${tab}`} aria-current={String(d.id) === whoParam ? "true" : undefined} className={String(d.id) === whoParam ? "font-medium text-ink" : "text-mute hover:text-ink"}>
            {d.name}
          </Link>
        ))}
      </nav>

      <p className="mb-6 flex flex-wrap gap-x-5 gap-y-1 text-small" aria-label="Today">
        <Link href={href({ tab: "pending", overdue: "1", open: "" })} className={today.overdue > 0 ? "font-medium text-accent" : "text-mute"}>
          Overdue {today.overdue}
        </Link>
        <span className="text-mute">Due within the hour {today.dueSoon}</span>
        <Link href={href({ tab: "all", booked: "1", open: "" })} className="text-mute hover:text-ink">
          Booked today {today.bookedToday}
        </Link>
        <Link href={href({ tab: "pending", afterHours: "1", open: "" })} className="text-mute hover:text-ink">
          Waiting from after hours {today.afterHoursWaiting}
        </Link>
      </p>

      <section aria-label="Calls">
        <div role="tablist" aria-label="Call lists" className="mb-2 flex flex-wrap gap-x-6 border-b border-line">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={href({ tab: t.key, open: "" })}
              role="tab"
              aria-selected={t.key === tab}
              className={`-mb-px border-b-2 py-2 ${t.key === tab ? "border-ink font-medium" : "border-transparent text-mute hover:text-ink"}`}
            >
              {t.label} <span className="text-small text-mute">{counts[t.key]}</span>
            </Link>
          ))}
        </div>

        <FilterBar tab={tab} filters={filters} basePath="/designers" hidden={{ who: whoParam }} />

        {rows.length === 0 ? (
          <p className="py-8 text-mute">{hasFilters(filters) ? "No calls match these filters." : tab === "pending" ? "Nothing is waiting for acknowledgement." : "No calls here yet."}</p>
        ) : (
          <CallList
            rows={rows}
            now={now}
            openId={openId}
            hrefFor={(id) => href({ open: id ? String(id) : "" , tab })}
            detail={detail ? <CallDetail detail={detail} now={now} /> : null}
            lastLabel="Deadline"
            lastCell={(c) => ackCell(c, now)}
            subline={who === "all" ? (c) => `With ${names.get(c.assignedDesignerId ?? -1) ?? "a designer"}` : undefined}
          />
        )}
      </section>
    </div>
  );
}
