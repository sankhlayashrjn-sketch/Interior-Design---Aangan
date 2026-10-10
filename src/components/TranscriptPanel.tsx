"use client";

import { Button } from "antd";
import { useActionState } from "react";
import { refreshTranscriptAction, type ActionState } from "@/app/actions";
import { N } from "@/components/neu/theme";
import type { Turn } from "@/lib/guardrail";

/**
 * The call's transcript, always visible at the top of the call (not tucked into a drop-down), with the recording to
 * play and a button to fetch the transcript from Vaani again. It fills in by itself shortly after the call, because
 * the page refreshes every 30 seconds.
 */
export function TranscriptPanel({ callId, turns, recordingUrl, followsEarlier }: { callId: number; turns: Turn[]; recordingUrl: string | null; followsEarlier: string | null }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(refreshTranscriptAction, {});
  return (
    <section className="n-card-sm p-5" aria-label="Transcript">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[16px] font-bold">
          Transcript <span className="text-small font-medium text-mute">{turns.length > 0 ? `${turns.length} turns, from Vaani` : "waiting for Vaani"}</span>
        </h3>
        <form action={action} className="flex items-center gap-3">
          <input type="hidden" name="callId" value={callId} />
          <span role="status" className="text-small text-mute">
            {state.error ?? state.ok ?? ""}
          </span>
          <Button htmlType="submit" loading={pending} size="small">
            {turns.length > 0 ? "Fetch again" : "Fetch from Vaani"}
          </Button>
        </form>
      </div>

      {recordingUrl && (
        <div className="n-inset-sm mb-4 px-4 py-3">
          <p className="mb-1 text-small font-semibold">Recording</p>
          <audio controls preload="none" src={recordingUrl} className="w-full" />
        </div>
      )}

      {followsEarlier && <p className="mb-3 text-small text-mute">Follows an earlier call from the same number at {followsEarlier}.</p>}

      {turns.length === 0 ? (
        <div className="n-inset-sm px-4 py-6 text-center">
          <p className="font-semibold">No transcript yet</p>
          <p className="mt-1 text-small text-mute">Vaani sends it a minute or two after the call ends. It will appear here by itself, or press Fetch from Vaani.</p>
        </div>
      ) : (
        <ol className="max-h-[460px] space-y-2 overflow-y-auto p-2" tabIndex={0} aria-label="Conversation">
          {turns.map((t, i) => (
            <li key={i} className={`flex ${t.speaker === "agent" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[85%] px-4 py-2.5 ${t.speaker === "agent" ? "n-card-sm" : "n-inset-sm"}`}>
                <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: t.speaker === "agent" ? N.accent : N.good }}>
                  {t.speaker === "agent" ? "Agent" : "Caller"}
                </div>
                <div>{t.text}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
