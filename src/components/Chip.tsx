import { FLAG_LABEL, STATUS_LABEL } from "@/lib/format";

/** Subtle tinted chip. Always carries a text label; colour is never the only signal. */
const TINT: Record<string, string> = {
  qualified: "bg-[#e8f1ea] text-[#1f4d2c]",
  needs_attention: "bg-[#f6eed8] text-[#6a4a0c]",
  disqualified: "bg-[#ececea] text-[#444444]",
  yet_to_be_processed: "bg-[#e9edf2] text-[#3c4858]",
  flag: "bg-transparent text-mute border border-line",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-small font-medium ${TINT[status] ?? TINT.disqualified}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function FlagChip({ flag }: { flag: string }) {
  if (flag === "none" || !FLAG_LABEL[flag]) return null;
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-small ${TINT.flag}`}>{FLAG_LABEL[flag]}</span>;
}
