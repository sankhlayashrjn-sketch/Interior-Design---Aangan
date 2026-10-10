"use client";

import { Table } from "antd";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { FlagChip, StatusChip } from "@/components/Chip";

/** A call, already turned into plain text by the server, so the table only draws. */
export interface CallRow {
  id: number;
  href: string;
  timeLabel: string;
  name: string;
  sub: string;
  score: number | null;
  status: string;
  flag: string;
  bookedLabel: string;
  lastText: string;
  lastOverdue: boolean;
}

/**
 * Calls as an accordion: click a row and the call opens directly underneath it (the address changes to ?open=<id>, so the
 * open call can be shared). Only the open call's details are loaded.
 */
export function CallTable({ rows, openId, closeHref, lastLabel, detail }: { rows: CallRow[]; openId: number | null; closeHref: string; lastLabel: string; detail: ReactNode }) {
  const router = useRouter();
  return (
    <div className="n-card overflow-hidden px-3 py-3 sm:px-5">
      <Table<CallRow>
        rowKey="id"
        dataSource={rows}
        size="middle"
        scroll={{ x: 720 }}
        pagination={rows.length > 15 ? { pageSize: 15, showSizeChanger: false } : false}
        rowClassName={(r) => (r.id === openId ? "m-row m-row-open" : "m-row")}
        onRow={(r) => ({ onClick: () => router.push(r.id === openId ? closeHref : r.href), style: { cursor: "pointer" } })}
        expandable={{
          expandedRowKeys: openId ? [openId] : [],
          expandedRowRender: () => <div className="n-inset px-3 py-4 sm:px-5">{detail}</div>,
          showExpandColumn: false,
        }}
        columns={[
          { title: "When", dataIndex: "timeLabel", width: 130, render: (v: string) => <span className="font-semibold">{v}</span> },
          {
            title: "Caller",
            dataIndex: "name",
            render: (_: string, r) => (
              <div className="min-w-0">
                <div className="truncate font-bold">{r.name}</div>
                <div className="truncate text-small text-mute">{r.sub}</div>
              </div>
            ),
          },
          {
            title: "Score",
            dataIndex: "score",
            width: 84,
            render: (s: number | null) =>
              s === null ? (
                "–"
              ) : (
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-bold" style={{ boxShadow: "inset 2px 2px 4px #b9c1d1, inset -2px -2px 4px #ffffff" }}>
                  {s}
                </span>
              ),
          },
          {
            title: "Status",
            dataIndex: "status",
            width: 200,
            render: (_: string, r) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusChip status={r.status} />
                <FlagChip flag={r.flag} />
              </span>
            ),
          },
          { title: "Booked", dataIndex: "bookedLabel", width: 130 },
          { title: lastLabel, dataIndex: "lastText", width: 150, render: (v: string, r) => <span className={r.lastOverdue ? "font-bold text-danger" : ""}>{v}</span> },
        ]}
        locale={{ emptyText: "Nothing here." }}
      />
    </div>
  );
}
