"use client";

import { FLAG_LABEL, STATUS_LABEL } from "@/lib/format";
import { N } from "@/components/dash/theme";

/**
 * Tinted pills with a dot and the word. The colour is the cue, the label carries the meaning, so nothing depends on
 * colour alone.
 */
const COLOR: Record<string, string> = {
  qualified: N.good,
  needs_attention: N.warn,
  disqualified: N.danger,
  yet_to_be_processed: N.info,
};

const pill = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] font-semibold";

export function StatusChip({ status }: { status: string }) {
  const c = COLOR[status] ?? N.mute;
  return (
    <span className={pill} style={{ background: `${c}22`, color: c }}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function FlagChip({ flag }: { flag: string }) {
  if (flag === "none" || !FLAG_LABEL[flag]) return null;
  return (
    <span className={pill} style={{ background: "rgba(255,255,255,0.07)", color: N.mute }}>
      {FLAG_LABEL[flag]}
    </span>
  );
}
