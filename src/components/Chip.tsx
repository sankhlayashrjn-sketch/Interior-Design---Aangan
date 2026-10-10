"use client";

import { FLAG_LABEL, STATUS_LABEL } from "@/lib/format";
import { N } from "@/components/neu/theme";

/**
 * Soft pills pressed into the surface, with a coloured dot and a text label. The dot is the colour cue, the words
 * carry the meaning, so nothing depends on colour alone.
 */
const DOT: Record<string, string> = {
  qualified: N.good,
  needs_attention: N.warn,
  disqualified: N.danger,
  yet_to_be_processed: N.info,
};

const pill = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] font-semibold";
const press = { boxShadow: "inset 2px 2px 4px #b9c1d1, inset -2px -2px 4px #ffffff" };

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={pill} style={press}>
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: DOT[status] ?? N.mute }} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function FlagChip({ flag }: { flag: string }) {
  if (flag === "none" || !FLAG_LABEL[flag]) return null;
  return (
    <span className={`${pill} text-mute`} style={press}>
      {FLAG_LABEL[flag]}
    </span>
  );
}
