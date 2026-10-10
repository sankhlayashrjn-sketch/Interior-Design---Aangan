"use client";

import { Segmented } from "antd";
import { useRouter } from "next/navigation";

export interface TabItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

/** The list switcher: a pressed-in track with a raised thumb. Choosing one navigates, so every view has its own address. */
export function TabsNav({ tabs, active }: { tabs: TabItem[]; active: string }) {
  const router = useRouter();
  return (
    <div className="mb-5 overflow-x-auto pb-1" role="tablist" aria-label="Call lists">
      <Segmented
        className="n-tabs"
        value={active}
        onChange={(k) => router.push(tabs.find((t) => t.key === k)!.href)}
        options={tabs.map((t) => ({
          value: t.key,
          label: (
            <span className="whitespace-nowrap px-2 py-1 text-[14px] font-semibold">
              {t.label} <span className="ml-1 rounded-full px-2 py-0.5 text-[12px] font-bold text-mute" style={{ boxShadow: "inset 2px 2px 4px #b9c1d1, inset -2px -2px 4px #ffffff" }}>{t.count}</span>
            </span>
          ),
        }))}
      />
    </div>
  );
}
