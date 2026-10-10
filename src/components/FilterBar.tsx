import Link from "next/link";
import type { SortKey } from "@/lib/calls";
import { STATUS_LABEL } from "@/lib/format";

export interface Filters {
  q: string;
  status: string;
  sort: SortKey | "";
  booked: boolean;
  overdue: boolean;
  afterHours: boolean;
}

export const hasFilters = (f: Filters) => !!(f.q || f.status || f.sort || f.booked || f.overdue || f.afterHours);

const field = "rounded border border-line bg-paper px-2 py-1.5 text-small";

/** Search and filters. A plain GET form, so it works without JavaScript and every view has a link you can share. */
export function FilterBar({ tab, filters, basePath = "/", hidden = {} }: { tab: string; filters: Filters; basePath?: string; hidden?: Record<string, string> }) {
  return (
    <form method="get" action={basePath} role="search" aria-label="Search and filter calls" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <input type="hidden" name="tab" value={tab} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input name="q" type="search" defaultValue={filters.q} placeholder="Search name, phone, area" aria-label="Search name, phone, area or notes" className={`${field} w-52`} />
      <select name="status" defaultValue={filters.status} aria-label="Status" className={field}>
        <option value="">Any status</option>
        {["qualified", "needs_attention", "disqualified"].map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <select name="sort" defaultValue={filters.sort} aria-label="Sort by" className={field}>
        <option value="">Default order</option>
        <option value="newest">Newest first</option>
        <option value="due">Deadline soonest</option>
        <option value="score">Highest score</option>
      </select>
      <label className="flex items-center gap-1.5 text-small">
        <input type="checkbox" name="overdue" value="1" defaultChecked={filters.overdue} />
        Overdue
      </label>
      <label className="flex items-center gap-1.5 text-small">
        <input type="checkbox" name="booked" value="1" defaultChecked={filters.booked} />
        Booked
      </label>
      <label className="flex items-center gap-1.5 text-small">
        <input type="checkbox" name="afterHours" value="1" defaultChecked={filters.afterHours} />
        After hours
      </label>
      <button type="submit" className="rounded border border-ink px-3 py-1.5 text-small font-medium">
        Apply
      </button>
      {hasFilters(filters) && (
        <Link href={`${basePath}?${new URLSearchParams({ ...hidden, tab }).toString()}`} className="text-small text-mute underline underline-offset-4 hover:text-ink">
          Clear
        </Link>
      )}
    </form>
  );
}
