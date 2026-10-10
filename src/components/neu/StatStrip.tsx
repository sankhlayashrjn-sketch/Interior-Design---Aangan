"use client";

import { Col, Row } from "antd";
import Link from "next/link";
import { N } from "./theme";

export interface Stat {
  label: string;
  value: number;
  tone: "pink" | "yellow" | "teal" | "blue";
  href?: string;
  /** Draw attention (for example, overdue and not zero). */
  hot?: boolean;
}

const DOT = { pink: N.danger, yellow: N.warn, teal: N.good, blue: N.info } as const;

/** The few numbers that matter today, as raised tiles. A pressed-in dot carries the colour; each tile links to its filtered list. */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <Row gutter={[22, 22]} className="mb-7">
      {stats.map((s) => {
        const tile = (
          <div className="n-card flex items-center justify-between gap-3 px-6 py-5 transition-transform hover:-translate-y-0.5">
            <div>
              <p className="text-small font-semibold text-mute">{s.label}</p>
              <p className="mt-1 text-[36px] font-bold leading-none tracking-tight" style={{ color: s.hot && s.value > 0 ? N.danger : N.ink }}>
                {s.value}
              </p>
            </div>
            <span className="n-inset-sm flex h-12 w-12 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
              <span className="block h-4 w-4 rounded-full" style={{ background: DOT[s.tone], opacity: s.value === 0 ? 0.35 : 1 }} />
            </span>
          </div>
        );
        return (
          <Col key={s.label} xs={24} sm={12} md={Math.floor(24 / stats.length)}>
            {s.href ? (
              <Link href={s.href} aria-label={`${s.label}: ${s.value}`}>
                {tile}
              </Link>
            ) : (
              tile
            )}
          </Col>
        );
      })}
    </Row>
  );
}
