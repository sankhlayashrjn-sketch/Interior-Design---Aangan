"use client";

import { Badge, Tabs } from "antd";
import { useRouter } from "next/navigation";
import { M } from "./theme";

export interface TabItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

/** Tabs that are real links underneath: choosing one navigates, so every view has its own address. */
export function TabsNav({ tabs, active }: { tabs: TabItem[]; active: string }) {
  const router = useRouter();
  return (
    <Tabs
      activeKey={active}
      onChange={(k) => router.push(tabs.find((t) => t.key === k)!.href)}
      items={tabs.map((t) => ({
        key: t.key,
        label: (
          <span className="font-bold">
            {t.label} <Badge count={t.count} showZero color={t.key === active ? M.ink : "#6b6b85"} style={{ marginLeft: 6 }} />
          </span>
        ),
      }))}
    />
  );
}
