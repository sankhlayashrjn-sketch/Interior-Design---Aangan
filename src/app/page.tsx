import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { assignCell, CallList } from "@/components/CallList";
import { FilterBar, hasFilters, type Filters } from "@/components/FilterBar";
import { eligibleDesigners, suggestDesignerFor, workloads } from "@/lib/assignment";
import { activeDesigners, countsForFrontDesk, getDetail, listForFrontDesk, todayForFrontDesk, type FrontDeskTab, type SortKey } from "@/lib/calls";
import { fmtDue } from "@/lib/format";

const TABS: { key: FrontDeskTab; label: string }[] = [
  { key: "assign", label: "To assign" },
  { key: "disqualified", label: "Disqualified" },
  { key: "assigned", label: "Assigned" },
  { key: "all", label: "All calls" },
];

const SORTS: SortKey[] = ["priority", "newest", "due", "score"];
const STATUSES = ["qualified", "needs_attention", "disqualified"];

type Params = { tab?: string; open?: string; q?: string; status?: string; sort?: string; booked?: string; overdue?: string; afterHours?: string };

/** The front desk inbox: every qualified or needs-attention call that nobody has taken yet, ready to hand to a designer. */
export default async function FrontDesk({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const tab: FrontDeskTab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as FrontDeskTab) : "assign";
  const now = new Date();
  const filters: Filters = {
    q: (sp.q ?? "").slice(0, 100),
    status: STATUSES.includes(sp.status ?? "") ? sp.status! : "",
    sort: SORTS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "",
    booked: sp.booked === "1",
    overdue: sp.overdue === "1",
    afterHours: sp.afterHours === "1",
  };
  const rows = await listForFrontDesk(tab, now, {
    q: filters.q,
    status: (filters.status || undefined) as never,
    sort: filters.sort || undefined,
    booked: filters.booked,
    overdue: filters.overdue,
    afterHours: filters.afterHours,
  });
  const counts = await countsForFrontDesk();
  const today = await todayForFrontDesk(now);
  const names = new Map((await activeDesigners()).map((d) => [d.id, d.name]));

  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries({ q: filters.q, status: filters.status, sort: filters.sort, booked: filters.booked ? "1" : "", overdue: filters.overdue ? "1" : "", afterHours: filters.afterHours ? "1" : "" })) if (v) keep.set(k, v);
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(over)) v ? p.set(k, v) : p.delete(k);
    return `/?${p.toString()}`;
  };

  // Only the open call needs its full detail, the suggested designer and the designers' current load.
  const openId = Number(sp.open) || null;
  const detail = openId ? await getDetail(openId) : null;
  let assign;
  if (detail) {
    const [designers, load, suggestedId] = await Promise.all([eligibleDesigners(), workloads(), suggestDesignerFor(detail.call)]);
    assign = { designers: designers.map((d) => ({ id: d.id, name: d.name, load: load.get(d.id) ?? 0 })), suggestedId };
  }

  return (
    <div>
      <AutoRefresh />
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-medium">Front desk</h1>
        <p className="text-small text-mute">{counts.assign} waiting to be assigned</p>
      </div>

      <p className="mb-6 flex flex-wrap gap-x-5 gap-y-1 text-small" aria-label="Today">
        <Link href="/?tab=assign&overdue=1" className={today.overdue > 0 ? "font-medium text-accent" : "text-mute"}>
          Overdue {today.overdue}
        </Link>
        <Link href="/?tab=assign&booked=1" className="text-mute hover:text-ink">
          Booked, not assigned {today.bookedToday}
        </Link>
        <Link href="/?tab=assign&afterHours=1" className="text-mute hover:text-ink">
          Came in after hours {today.afterHours}
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

        <FilterBar tab={tab} filters={filters} />

        {rows.length === 0 ? (
          <p className="py-8 text-mute">{hasFilters(filters) ? "No calls match these filters." : tab === "assign" ? "Every call has a designer. Nothing to assign." : "No calls here yet."}</p>
        ) : (
          <CallList
            rows={rows}
            now={now}
            openId={openId}
            hrefFor={(id) => href({ tab, open: id ? String(id) : "" })}
            detail={detail ? <CallDetail detail={detail} now={now} assign={assign} /> : null}
            lastLabel={tab === "assign" ? "Assign by" : "Status"}
            subline={tab === "assigned" || tab === "all" ? (c) => c.assignedDesignerId ? `With ${names.get(c.assignedDesignerId) ?? "a designer"}` : "Not assigned yet" : undefined}
            lastCell={(c) => (tab === "assign" ? assignCell(c, now) : { text: c.assignedDesignerId ? (c.acknowledgedAt ? "Acknowledged" : fmtDue(c.dueAt, null, now).text) : "–", overdue: false })}
          />
        )}
      </section>
    </div>
  );
}
