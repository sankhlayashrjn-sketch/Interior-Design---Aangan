import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallDetail } from "@/components/CallDetail";
import { FilterBar, type Filters } from "@/components/FilterBar";
import { CallTable } from "@/components/neu/CallTable";
import { PageBanner } from "@/components/neu/PageBanner";
import { StatStrip } from "@/components/neu/StatStrip";
import { TabsNav } from "@/components/neu/TabsNav";
import { activeDesigners, countsForDesigner, getDetail, listForDesigner, todayForDesigner, type SortKey, type Tab } from "@/lib/calls";
import { fmtDue } from "@/lib/format";
import { toRow } from "@/lib/rows";
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
  if (designers.length === 0) return <p>No designers yet. Add one in Settings.</p>;

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
  const calls = await listForDesigner(who, tab, now, {
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

  const rows = calls.map((c) => {
    const d = fmtDue(c.dueAt, c.acknowledgedAt, now);
    return toRow(c, now, href({ tab, open: String(c.id) }), { text: d.text, overdue: d.state === "overdue" }, who === "all" ? `With ${names.get(c.assignedDesignerId ?? -1) ?? "a designer"}` : undefined);
  });

  return (
    <div>
      <AutoRefresh />
      <PageBanner title={whoName} tone="teal" subtitle={`${counts.pending} waiting for acknowledgement`} />

      <nav aria-label="Designer" className="mb-7 flex flex-wrap gap-3">
        {[{ id: "all" as const, name: "Everyone" }, ...designers].map((d) => {
          const on = String(d.id) === whoParam;
          return (
            <Link
              key={d.id}
              href={`/designers?who=${d.id}&tab=${tab}`}
              aria-current={on ? "true" : undefined}
              className={`rounded-full px-5 py-2 text-small font-semibold text-ink no-underline ${on ? "n-inset-sm" : "n-card-sm"}`}
            >
              {d.name}
            </Link>
          );
        })}
      </nav>

      <StatStrip
        stats={[
          { label: "Overdue", value: today.overdue, tone: "pink", href: href({ tab: "pending", overdue: "1", open: "" }), hot: true },
          { label: "Due within the hour", value: today.dueSoon, tone: "yellow" },
          { label: "Booked today", value: today.bookedToday, tone: "teal", href: href({ tab: "all", booked: "1", open: "" }) },
          { label: "Waiting from after hours", value: today.afterHoursWaiting, tone: "blue", href: href({ tab: "pending", afterHours: "1", open: "" }) },
        ]}
      />

      <TabsNav active={tab} tabs={TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key], href: href({ tab: t.key, open: "" }) }))} />
      <FilterBar tab={tab} filters={filters} basePath="/designers" hidden={{ who: whoParam }} />

      <CallTable rows={rows} openId={openId} closeHref={href({ tab, open: "" })} lastLabel="Deadline" detail={detail ? <CallDetail detail={detail} now={now} /> : null} />
    </div>
  );
}
