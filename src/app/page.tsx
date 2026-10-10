import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { FilterBar, type Filters } from "@/components/FilterBar";
import { CallTable } from "@/components/dash/CallTable";
import { PageBanner } from "@/components/dash/PageBanner";
import { StatStrip } from "@/components/dash/StatStrip";
import { TabsNav } from "@/components/dash/TabsNav";
import { eligibleDesigners, suggestDesignerFor, workloads } from "@/lib/assignment";
import { activeDesigners, countsForFrontDesk, getDetail, listForFrontDesk, todayForFrontDesk, type FrontDeskTab, type SortKey } from "@/lib/calls";
import { fmtDue } from "@/lib/format";
import { toRow } from "@/lib/rows";

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
  const calls = await listForFrontDesk(tab, now, {
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

  const rows = calls.map((c) => {
    let last: { text: string; overdue: boolean };
    if (tab === "assign") {
      const d = c.assignDueAt ? fmtDue(c.assignDueAt, null, now) : null;
      last = { text: d?.text ?? "–", overdue: d?.state === "overdue" };
    } else {
      last = { text: c.assignedDesignerId ? (c.acknowledgedAt ? "Acknowledged" : fmtDue(c.dueAt, null, now).text) : "–", overdue: false };
    }
    const sub = tab === "assigned" || tab === "all" ? (c.assignedDesignerId ? `With ${names.get(c.assignedDesignerId) ?? "a designer"}` : "Not assigned yet") : undefined;
    return toRow(c, now, href({ tab, open: String(c.id) }), last, sub);
  });

  return (
    <div>
      <AutoRefresh />
      <PageBanner title="Front desk" tone="pink" subtitle={counts.assign === 0 ? "Everything is assigned. Nice." : `${counts.assign} ${counts.assign === 1 ? "call is" : "calls are"} waiting for a designer`} />

      <StatStrip
        stats={[
          { label: "Overdue", value: today.overdue, tone: "pink", href: "/?tab=assign&overdue=1", hot: true, hint: today.overdue ? "past the deadline" : "all on time" },
          { label: "Booked, not assigned", value: today.bookedToday, tone: "yellow", href: "/?tab=assign&booked=1", hint: today.bookedToday ? "needs a designer" : "none" },
          { label: "Came in after hours", value: today.afterHours, tone: "teal", href: "/?tab=assign&afterHours=1", hint: today.afterHours ? "night calls" : "none" },
        ]}
      />

      <TabsNav active={tab} tabs={TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key], href: href({ tab: t.key, open: "" }) }))} />
      <FilterBar tab={tab} filters={filters} />

      <CallTable
        rows={rows}
        openId={openId}
        closeHref={href({ tab, open: "" })}
        lastLabel={tab === "assign" ? "Assign by" : "Status"}
        detail={detail ? <CallDetail detail={detail} now={now} assign={assign} /> : null}
      />
    </div>
  );
}
