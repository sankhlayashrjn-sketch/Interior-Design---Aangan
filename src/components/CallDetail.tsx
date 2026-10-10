"use client";

import { Alert, Collapse, Descriptions, Table } from "antd";
import { AcknowledgeButton } from "@/components/AcknowledgeButton";
import { AssignForm, type AssignOption } from "@/components/AssignForm";
import { FlagChip, StatusChip } from "@/components/Chip";
import { NoteForm } from "@/components/NoteForm";
import { OverrideForm } from "@/components/OverrideForm";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { N } from "@/components/neu/theme";
import type { getDetail } from "@/lib/calls";
import { fmtDateTime, fmtDue, PROPERTY_LABEL } from "@/lib/format";
import { splitTurns } from "@/lib/guardrail";
import { CRITERIA } from "@/lib/rubric";

type Detail = NonNullable<Awaited<ReturnType<typeof getDetail>>>;

export interface AssignPanel {
  designers: AssignOption[];
  suggestedId: number | null;
}

const dim = { color: N.mute } as const;

/**
 * One call in full, as a stack of drop-downs: handoff note, transcript, booking, score, notes, timeline, override.
 * The front desk sees the assignment control; designers see Acknowledge. The sections are the same for both, so a
 * designer can audit the call (read the transcript, check the score) before acknowledging it.
 */
export function CallDetail({ detail, now = new Date(), assign }: { detail: Detail; now?: Date; assign?: AssignPanel }) {
  const { call, assignedTo, assignedByName, acknowledgedByName, bookingWith, overrides, notes, timeline, linked } = detail;
  const due = fmtDue(call.dueAt, call.acknowledgedAt, now);
  const processed = call.status !== "yet_to_be_processed";
  const turns = splitTurns(call.transcript);

  const field = (label: string, value: React.ReactNode) => ({ key: label, label, children: value || <span style={dim}>Not stated</span> });

  const items = [
    {
      key: "handoff",
      label: <b>Handoff note</b>,
      children: !processed ? (
        <p style={dim}>Still being processed.</p>
      ) : (
        <div className="space-y-3">
          {call.reason && call.status !== "qualified" && (
            <p>
              <b>Why: </b>
              {call.reason}
            </p>
          )}
          <p className="whitespace-pre-line">{call.summary}</p>
          <Descriptions column={1} size="small" colon={false} items={[field("Already asked", call.alreadyAsked), field("Next step", call.suggestedNextStep)]} />
        </div>
      ),
    },
    {
      key: "booking",
      label: <b>Booking</b>,
      children: call.bookedSlot ? (
        <p>
          <b>{fmtDateTime(call.bookedSlot)}</b>
          {bookingWith ? <span> · with {bookingWith}</span> : null}
          {call.bookingStatus && call.bookingStatus !== "booked" ? <span style={dim}> · {call.bookingStatus}</span> : null}
        </p>
      ) : (
        <p style={dim}>No slot booked.</p>
      ),
    },
    {
      key: "fields",
      label: <b>Caller details</b>,
      children: (
        <Descriptions
          column={{ xs: 1, md: 2 }}
          size="small"
          bordered
          items={[
            field("Name", call.callerName),
            field("Phone", call.callerPhone ?? "Caller ID withheld"),
            field("Email", call.callerEmail),
            field("Location", call.location),
            field("Property", PROPERTY_LABEL(call.propertyType)),
            field("Area", call.areaSqft ? `${call.areaSqft.toLocaleString("en-IN")} sq ft` : null),
            field("Scope", call.scope),
            field("Timeline", call.timeline),
            field("Budget (caller's words)", call.budget),
          ]}
        />
      ),
    },
    {
      key: "score",
      label: <b>Score {call.score !== null ? `${call.score} / 100` : "(not scored)"}</b>,
      children: call.scoreBreakdown ? (
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          scroll={{ x: 520 }}
          dataSource={CRITERIA.map((c) => ({ key: c.key, label: c.label, ...call.scoreBreakdown![c.key] }))}
          columns={[
            { title: "Criterion", dataIndex: "label", width: 200 },
            { title: "Points", width: 90, render: (_: unknown, r: { points: number; max: number }) => <b>{r.points} / {r.max}</b> },
            { title: "Evidence", dataIndex: "evidence", render: (v: string) => <span style={dim}>{v}</span> },
          ]}
        />
      ) : (
        <p style={dim}>{call.flag === "existing_client" ? "Not a new enquiry, so it is not scored." : "No breakdown available."}</p>
      ),
    },
    {
      key: "notes",
      label: <b>Notes {notes.length > 0 && <span style={dim}>({notes.length})</span>}</b>,
      children: (
        <div>
          {notes.length === 0 ? (
            <p style={dim}>No notes yet.</p>
          ) : (
            <ul className="space-y-3">
              {notes.map((n) => (
                <li key={n.id} className="border-l-4 border-accent pl-3">
                  <p className="whitespace-pre-line">{n.body}</p>
                  <p className="text-small" style={dim}>
                    {n.byName ?? "Someone"} · {fmtDateTime(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <NoteForm callId={call.id} />
        </div>
      ),
    },
    {
      key: "timeline",
      label: <b>Timeline</b>,
      children: (
        <ol className="space-y-3">
          {timeline.map((e, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ boxShadow: "inset 2px 2px 4px #b9c1d1, inset -2px -2px 4px #ffffff" }}>
                <span className="block h-2 w-2 rounded-full" style={{ background: [N.accent, N.warn, N.good, N.info][i % 4] }} />
              </span>
              <span>
                <span className="text-small font-semibold" style={dim}>
                  {fmtDateTime(e.at).replace(" IST", "")}
                </span>
                <br />
                {e.text}
              </span>
            </li>
          ))}
        </ol>
      ),
    },
    ...(processed
      ? [
          {
            key: "override",
            label: <b>Change the status</b>,
            children: (
              <div>
                <OverrideForm callId={call.id} current={call.status} />
                {overrides.length > 0 && (
                  <ul className="mt-4 space-y-2 text-small">
                    {overrides.map((o) => (
                      <li key={o.id} style={dim}>
                        {fmtDateTime(o.at)} · {o.byName ?? "Unknown"} changed {o.fromStatus.replace(/_/g, " ")} to {o.toStatus.replace(/_/g, " ")}: {o.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  const canAssign = processed && assign && !call.acknowledgedAt && call.status !== "disqualified";
  const canAcknowledge = processed && !assign && call.assignedDesignerId;

  return (
    <article aria-label="Call detail" className="space-y-4 py-2">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[24px] font-bold leading-tight">{call.callerName ?? call.callerPhone ?? "Unknown caller"}</h2>
          <StatusChip status={call.status} />
          <FlagChip flag={call.flag} />
        </div>
        <p className="mt-1 text-small" style={dim}>
          {fmtDateTime(call.startedAt)} · {call.durationSec > 0 ? `${Math.round((call.durationSec / 60) * 10) / 10} min` : "length not reported"} · {call.callerPhone ?? "Caller ID withheld"}
          {call.callerEmail ? ` · ${call.callerEmail}` : ""} ·{" "}
          {assignedTo ? `Assigned to ${assignedTo}${assignedByName ? ` by ${assignedByName}` : ""}` : "Not assigned yet"}
          {call.afterHours ? " · After hours" : ""}
        </p>
              </header>

      {canAssign && (
        <div className="n-card-sm p-5">
          <AssignForm callId={call.id} designers={assign!.designers} suggestedId={assign!.suggestedId} currentId={call.assignedDesignerId} />
        </div>
      )}

      {canAcknowledge && (
        <div className="n-card-sm flex flex-wrap items-center gap-4 p-5">
          {call.acknowledgedAt ? (
            <p className="font-bold" style={{ color: N.good }}>
              Acknowledged by {acknowledgedByName} · {due.text.replace("Acknowledged ", "")}
            </p>
          ) : (
            <>
              <AcknowledgeButton callId={call.id} />
              <p className={due.state === "overdue" ? "font-bold text-danger" : "font-semibold"}>{due.text}</p>
            </>
          )}
        </div>
      )}

      {call.guardrailHits && call.guardrailHits.length > 0 && (
        <Alert type="warning" showIcon={false} message={`Price guardrail: ${call.guardrailHits.join("; ")}. Do not quote prices; the designer gives a quote at the consultation.`} className="n-inset-sm" />
      )}

      <TranscriptPanel callId={call.id} turns={turns} recordingUrl={call.recordingUrl} followsEarlier={linked ? fmtDateTime(linked.startedAt) : null} />

      <Collapse className="n-collapse" items={items} defaultActiveKey={["handoff"]} bordered={false} expandIconPlacement="end" />
    </article>
  );
}
