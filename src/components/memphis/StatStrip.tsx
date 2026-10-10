"use client";

import { Card, Col, Row, Statistic } from "antd";
import Link from "next/link";
import { M } from "./theme";

export interface Stat {
  label: string;
  value: number;
  tone: "pink" | "yellow" | "teal" | "blue";
  href?: string;
  /** Draw attention (for example, overdue and not zero). */
  hot?: boolean;
}

const BG = { pink: M.pink, yellow: M.yellow, teal: M.teal, blue: "#9BC1FF" } as const;

/** The few numbers that matter today, as chunky coloured blocks. Each one links to the matching filtered list. */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <Row gutter={[16, 16]} className="mb-6">
      {stats.map((s) => {
        const card = (
          <Card variant="borderless" styles={{ body: { padding: 16 } }} style={{ background: BG[s.tone], border: `2px solid ${M.ink}`, boxShadow: `5px 5px 0 ${M.ink}`, borderRadius: 14, opacity: s.value === 0 && s.hot ? 0.85 : 1 }}>
            <Statistic title={<span style={{ color: M.ink, fontWeight: 700 }}>{s.label}</span>} value={s.value} styles={{ content: { color: M.ink, fontWeight: 800 } }} />
          </Card>
        );
        return (
          <Col key={s.label} xs={12} md={Math.floor(24 / stats.length)}>
            {s.href ? (
              <Link href={s.href} aria-label={`${s.label}: ${s.value}`}>
                {card}
              </Link>
            ) : (
              card
            )}
          </Col>
        );
      })}
    </Row>
  );
}
