import Link from "next/link";
import { acknowledgeAction } from "@/app/actions";
import { FlagChip, StatusChip } from "@/components/Chip";
import { NoteForm } from "@/components/NoteForm";
import { OverrideForm } from "@/components/OverrideForm";
import type { getDetail } from "@/lib/calls";
import { fmtDateTime, fmtDue, PROPERTY_LABEL } from "@/lib/format";
import { splitTurns } from "@/lib/guardrail";
import { CRITERIA } from "@/lib/rubric";

type Detail = NonNullable<Awaited<ReturnType<typeof getDetail>>>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-5">
      <h3 className="mb-3 text-small font-medium text-mute">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-1">
      <dt className="text-mute">{label}</dt>
      <dd>{value || <span className="text-mute">Not stated</span>}</dd>
    </div>
  );
}

export function CallDetail({ detail, backHref, now = new Date() }: { detail: Detail; backHref: string; now?: Date }) {
  const { call, assignedTo, acknowledgedByName, overrides, notes, timeline, linked } = detail;
  const due = fmtDue(call.dueAt, call.acknowledgedAt, now);
  const processed = call.status !== "yet_to_be_processed";
  const turns = splitTurns(call.transcript);

  return (
    <article aria-label="Call detail">
      <Link href={backHref} className="mb-4 inline-block text-small text-mute hover:text-ink xl:hidden">
        Back to list
      </Link>

      <header className="pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-title font-medium">{call.callerName ?? call.callerPhone ?? "Unknown caller"}</h2>
          <StatusChip status={call.status} />
          <FlagChip flag={call.flag} />
        </div>
        <p className="mt-1 text-small text-mute">
          {fmtDateTime(call.startedAt)} · {Math.round(call.durationSec / 60 * 10) / 10} min · {call.callerPhone ?? "Caller ID withheld"} · Assigned to {assignedTo ?? "nobody"}
          {call.afterHours ? " · After hours" : ""}
        </p>
        {call.recordingUrl && (
          <p className="mt-1 text-small">
            <a href={call.recordingUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
              Listen to the call
            </a>
          </p>
        )}
        {call.reason && call.status !== "qualified" && (
          <p className="mt-3">
            <span className="font-medium">Why: </span>
            {call.reason}
          </p>
        )}
      </header>

      {processed && (
        <div className="flex flex-wrap items-center gap-4 pb-5">
          {call.acknowledgedAt ? (
            <p className="text-mute">Acknowledged by {acknowledgedByName} · {due.text.replace("Acknowledged ", "")}</p>
          ) : (
            <form action={acknowledgeAction}>
              <input type="hidden" name="callId" value={call.id} />
              <button type="submit" className="rounded bg-accent px-4 py-2 font-medium text-white">
                Acknowledge
              </button>
            </form>
          )}
          {!call.acknowledgedAt && <p className={due.state === "overdue" ? "font-medium text-accent" : "text-mute"}>{due.text}</p>}
        </div>
      )}

      {call.guardrailHits && call.guardrailHits.length > 0 && (
        <p className="mb-2 border-l-2 border-ink pl-3 text-small">
          Price guardrail: {call.guardrailHits.join("; ")}. Do not quote prices; the designer gives a quote at the consultation.
        </p>
      )}

      {!processed ? (
        <Section title="Handoff note">
          <p className="text-mute">Still being processed.</p>
        </Section>
      ) : (
        <>
          <Section title="Handoff note">
            <p className="whitespace-pre-line">{call.summary}</p>
            <dl className="mt-4">
              <Field label="Already asked" value={call.alreadyAsked} />
              <Field label="Next step" value={call.suggestedNextStep} />
            </dl>
          </Section>

          <Section title="Booking">
            {call.bookedSlot ? (
              <p>
                {fmtDateTime(call.bookedSlot)}
                {call.bookingStatus && call.bookingStatus !== "booked" ? <span className="text-mute"> · {call.bookingStatus}</span> : null}
                {call.score !== null && (
                  <span className="text-mute">
                    {" "}
                    · this caller scored {call.score} ({call.status.replace(/_/g, " ")})
                  </span>
                )}
              </p>
            ) : (
              <p className="text-mute">No slot booked.</p>
            )}
          </Section>

          <Section title="Notes">
            {notes.length === 0 ? (
              <p className="text-mute">No notes yet.</p>
            ) : (
              <ul className="space-y-3">
                {notes.map((n) => (
                  <li key={n.id}>
                    <p className="whitespace-pre-line">{n.body}</p>
                    <p className="text-small text-mute">
                      {n.byName ?? "Someone"} · {fmtDateTime(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <NoteForm callId={call.id} />
          </Section>

          <Section title="Extracted fields">
            <dl>
              <Field label="Name" value={call.callerName} />
              <Field label="Phone" value={call.callerPhone ?? "Caller ID withheld"} />
              <Field label="Location" value={call.location} />
              <Field label="Property" value={PROPERTY_LABEL(call.propertyType)} />
              <Field label="Area" value={call.areaSqft ? `${call.areaSqft.toLocaleString("en-IN")} sq ft` : null} />
              <Field label="Scope" value={call.scope} />
              <Field label="Timeline" value={call.timeline} />
              <Field label="Budget (caller's words)" value={call.budget} />
            </dl>
          </Section>

          <Section title={`Score${call.score !== null ? `: ${call.score} / 100` : ": not scored"}`}>
            {call.scoreBreakdown ? (
              <table className="w-full text-left">
                <thead className="sr-only">
                  <tr>
                    <th>Criterion</th>
                    <th>Points</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {CRITERIA.map((c) => {
                    const b = call.scoreBreakdown![c.key];
                    return (
                      <tr key={c.key} className="border-t border-line align-top first:border-t-0">
                        <td className="whitespace-nowrap py-2 pr-4">{c.label}</td>
                        <td className="whitespace-nowrap py-2 pr-4 tabular-nums">
                          {b.points} / {b.max}
                        </td>
                        <td className="py-2 text-mute">{b.evidence}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-mute">
                {call.flag === "existing_client" ? "Not a new enquiry, so it is not scored." : "No breakdown available."}
              </p>
            )}
          </Section>
        </>
      )}

      {processed && (
        <Section title="Status override">
          <OverrideForm callId={call.id} current={call.status} />
          {overrides.length > 0 && (
            <ul className="mt-4 space-y-2 text-small">
              {overrides.map((o) => (
                <li key={o.id} className="text-mute">
                  {fmtDateTime(o.at)} · {o.byName ?? "Unknown"} changed {o.fromStatus.replace(/_/g, " ")} to {o.toStatus.replace(/_/g, " ")}: {o.reason}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Timeline">
        <ol className="space-y-2">
          {timeline.map((e, i) => (
            <li key={i} className="grid grid-cols-[9.5rem_1fr] gap-3">
              <span className="text-small text-mute">{fmtDateTime(e.at).replace(" IST", "")}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Transcript">
        {linked && <p className="mb-3 text-small text-mute">Follows an earlier call from the same number at {fmtDateTime(linked.startedAt)}.</p>}
        {turns.length === 0 ? (
          <p className="text-mute">No transcript was captured.</p>
        ) : (
          <ol className="space-y-3">
            {turns.map((t, i) => (
              <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-3">
                <span className="text-small text-mute">{t.speaker === "agent" ? "Agent" : "Caller"}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </article>
  );
}
