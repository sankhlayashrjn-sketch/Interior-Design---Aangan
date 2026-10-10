"use client";

import Link from "next/link";
import { N } from "./theme";

export interface Stat {
  label: string;
  value: number;
  tone: "pink" | "yellow" | "teal" | "blue";
  href?: string;
  /** Draw attention (for example, overdue and not zero). */
  hot?: boolean;
  /** A few words under the number, in the tone's colour. */
  hint?: string;
}

const COLOR = { pink: N.danger, yellow: N.warn, teal: N.good, blue: N.info } as const;

/**
 * The few numbers that matter today, in ONE panel with dividers between them (like the reference's top strip).
 * Each is a link to the matching filtered list. A small tinted chip says what the number means.
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="n-card mb-6 grid grid-cols-2 gap-y-5 px-2 py-5 md:flex md:items-stretch md:px-0 md:py-6">
      {stats.map((s, i) => {
        const color = s.hot && s.value > 0 ? N.danger : s.value === 0 ? N.mute : COLOR[s.tone];
        const body = (
          <div className="px-5 md:px-8">
            <p className="text-small font-medium text-mute">{s.label}</p>
            <p className="mt-1 text-[34px] font-bold leading-none tracking-tight">{s.value}</p>
            <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold" style={{ background: `${color}22`, color }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              {s.hint ?? (s.value === 0 ? "none" : "waiting")}
            </span>
          </div>
        );
        return (
          <div key={s.label} className={`min-w-0 flex-1 ${i > 0 ? "md:border-l md:border-line" : ""}`}>
            {s.href ? (
              <Link href={s.href} aria-label={`${s.label}: ${s.value}`} className="block text-ink transition-opacity hover:opacity-85">
                {body}
              </Link>
            ) : (
              body
            )}
          </div>
        );
      })}
    </div>
  );
}
