"use client";

import { Tag } from "antd";
import { FLAG_LABEL, STATUS_LABEL } from "@/lib/format";
import { M } from "@/components/memphis/theme";

/** Memphis tags: flat colour, black outline. Always carries a text label; colour is never the only signal. */
const FILL: Record<string, { bg: string; fg: string }> = {
  qualified: { bg: M.teal, fg: M.ink },
  needs_attention: { bg: M.yellow, fg: M.ink },
  disqualified: { bg: M.pink, fg: M.ink },
  yet_to_be_processed: { bg: M.blue, fg: "#fff" },
};

const base = { border: `2px solid ${M.ink}`, borderRadius: 999, fontWeight: 700, margin: 0, paddingInline: 10 } as const;

export function StatusChip({ status }: { status: string }) {
  const c = FILL[status] ?? FILL.disqualified;
  return <Tag style={{ ...base, background: c.bg, color: c.fg }}>{STATUS_LABEL[status] ?? status}</Tag>;
}

export function FlagChip({ flag }: { flag: string }) {
  if (flag === "none" || !FLAG_LABEL[flag]) return null;
  return <Tag style={{ ...base, background: "#fff", color: M.ink, fontWeight: 600 }}>{FLAG_LABEL[flag]}</Tag>;
}
