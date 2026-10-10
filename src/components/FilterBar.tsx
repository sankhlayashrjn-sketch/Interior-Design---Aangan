"use client";

import { Button, Checkbox, Input, Select } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SortKey } from "@/lib/calls";

export interface Filters {
  q: string;
  status: string;
  sort: SortKey | "";
  booked: boolean;
  overdue: boolean;
  afterHours: boolean;
}

export const hasFilters = (f: Filters) => !!(f.q || f.status || f.sort || f.booked || f.overdue || f.afterHours);

/** Search and filters. Each change goes to the address bar, so every view can be shared and survives a refresh. */
export function FilterBar({ tab, filters, basePath = "/", hidden = {} }: { tab: string; filters: Filters; basePath?: string; hidden?: Record<string, string> }) {
  const router = useRouter();
  const [f, setF] = useState(filters);

  const go = (next: Filters) => {
    setF(next);
    const p = new URLSearchParams({ ...hidden, tab });
    if (next.q) p.set("q", next.q);
    if (next.status) p.set("status", next.status);
    if (next.sort) p.set("sort", next.sort);
    if (next.booked) p.set("booked", "1");
    if (next.overdue) p.set("overdue", "1");
    if (next.afterHours) p.set("afterHours", "1");
    router.push(`${basePath}?${p.toString()}`);
  };
  const clear = { q: "", status: "", sort: "" as const, booked: false, overdue: false, afterHours: false };

  return (
    <div role="search" aria-label="Search and filter calls" className="n-card mb-5 flex flex-wrap items-center gap-x-5 gap-y-4 px-6 py-5">
      <Input.Search
        placeholder="Search name, phone, area, notes"
        allowClear
        defaultValue={f.q}
        onSearch={(q) => go({ ...f, q })}
        style={{ width: 290 }}
        aria-label="Search name, phone, area or notes"
      />
      <Select
        value={f.status}
        onChange={(status) => go({ ...f, status })}
        style={{ width: 175 }}
        aria-label="Status"
        options={[
          { value: "", label: "Any status" },
          { value: "qualified", label: "Qualified" },
          { value: "needs_attention", label: "Needs attention" },
          { value: "disqualified", label: "Disqualified" },
        ]}
      />
      <Select
        value={f.sort}
        onChange={(sort) => go({ ...f, sort: sort as SortKey | "" })}
        style={{ width: 175 }}
        aria-label="Sort by"
        options={[
          { value: "", label: "Default order" },
          { value: "newest", label: "Newest first" },
          { value: "due", label: "Deadline soonest" },
          { value: "score", label: "Highest score" },
        ]}
      />
      <Checkbox checked={f.overdue} onChange={(e) => go({ ...f, overdue: e.target.checked })}>
        Overdue
      </Checkbox>
      <Checkbox checked={f.booked} onChange={(e) => go({ ...f, booked: e.target.checked })}>
        Booked
      </Checkbox>
      <Checkbox checked={f.afterHours} onChange={(e) => go({ ...f, afterHours: e.target.checked })}>
        After hours
      </Checkbox>
      {hasFilters(f) && <Button onClick={() => go(clear)}>Clear</Button>}
    </div>
  );
}
