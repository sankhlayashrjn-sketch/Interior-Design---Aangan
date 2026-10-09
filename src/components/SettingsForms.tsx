"use client";

import { useActionState } from "react";
import { addDesignerAction, saveDesignerAction, saveSettingsAction, telegramLinkAction, type FormState } from "@/app/settings/actions";

const input = "mt-1 w-full rounded border border-line bg-paper px-2 py-1.5";
const label = "block text-small text-mute";
const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

function Status({ state }: { state: FormState }) {
  return (
    <p role="status" className={`min-h-[1.5em] text-small ${state.error ? "font-medium text-ink" : "text-mute"}`}>
      {state.error ?? state.ok ?? ""}
    </p>
  );
}

export interface SettingsData {
  workStart: string;
  workEnd: string;
  workDays: number[];
  holidays: string[];
  slaMinutes: number;
  slotAlertMinutes: number;
  aiModel: string;
}

export function SettingsForm({ s }: { s: SettingsData }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveSettingsAction, {});
  return (
    <form action={action} className="space-y-6">
      <fieldset>
        <legend className={label}>Working hours (IST). Reminders count working time only.</legend>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <input type="time" name="workStart" aria-label="Opens" defaultValue={s.workStart} required className="rounded border border-line bg-paper px-2 py-1.5" />
          <span className="text-mute">to</span>
          <input type="time" name="workEnd" aria-label="Closes" defaultValue={s.workEnd} required className="rounded border border-line bg-paper px-2 py-1.5" />
        </div>
      </fieldset>

      <fieldset>
        <legend className={label}>Working days</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          {DAYS.map((d) => (
            <label key={d.n} className="flex items-center gap-2">
              <input type="checkbox" name="workDays" value={d.n} defaultChecked={s.workDays.includes(d.n)} />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="holidays" className={label}>
          Holidays (one date per line, YYYY-MM-DD)
        </label>
        <textarea id="holidays" name="holidays" rows={3} defaultValue={s.holidays.join("\n")} className={`${input} max-w-xs`} />
      </div>

      <div className="grid max-w-xl gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="sla" className={label}>
            SLA: acknowledge within (working minutes)
          </label>
          <input id="sla" name="slaMinutes" type="number" min={1} max={1440} defaultValue={s.slaMinutes} required className={input} />
        </div>
        <div>
          <label htmlFor="slot" className={label}>
            Urgent alert before a booked slot (minutes)
          </label>
          <input id="slot" name="slotAlertMinutes" type="number" min={0} max={1440} defaultValue={s.slotAlertMinutes} required className={input} />
        </div>
      </div>

      <div className="max-w-xl">
        <label htmlFor="model" className={label}>
          AI model name (used when AI_MODE=live)
        </label>
        <input id="model" name="aiModel" defaultValue={s.aiModel} required className={input} />
      </div>

      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
          {pending ? "Saving" : "Save settings"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export interface DesignerData {
  id: number;
  name: string;
  telegramChatId: string | null;
  hubspotOwnerId: string | null;
  calcomUser: string | null;
  active: boolean;
  isEscalation: boolean;
}

export function DesignerRow({ d }: { d: DesignerData }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveDesignerAction, {});
  const [link, linkAction, linking] = useActionState<FormState, FormData>(telegramLinkAction, {});
  return (
    <li className="border-b border-line py-5">
      <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="id" value={d.id} />
        <div>
          <label htmlFor={`n${d.id}`} className={label}>
            Name
          </label>
          <input id={`n${d.id}`} name="name" defaultValue={d.name} required className={input} />
        </div>
        <div>
          <label htmlFor={`t${d.id}`} className={label}>
            Telegram chat ID
          </label>
          <input id={`t${d.id}`} name="telegramChatId" defaultValue={d.telegramChatId ?? ""} inputMode="numeric" placeholder="Filled in by the link" className={input} />
        </div>
        <div>
          <label htmlFor={`h${d.id}`} className={label}>
            HubSpot owner ID
          </label>
          <input id={`h${d.id}`} name="hubspotOwnerId" defaultValue={d.hubspotOwnerId ?? ""} inputMode="numeric" className={input} />
        </div>
        <div>
          <label htmlFor={`c${d.id}`} className={label}>
            Cal.com user
          </label>
          <input id={`c${d.id}`} name="calcomUser" defaultValue={d.calcomUser ?? ""} placeholder="username or email" className={input} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:col-span-2 lg:col-span-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="active" defaultChecked={d.active} />
            Takes new calls
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="isEscalation" defaultChecked={d.isEscalation} />
            Studio head (complaints, and copies of urgent alerts)
          </label>
          <button type="submit" disabled={pending} className="rounded border border-ink px-3 py-1.5 font-medium disabled:opacity-50">
            {pending ? "Saving" : "Save"}
          </button>
          <Status state={state} />
        </div>
      </form>

      <form action={linkAction} className="mt-2 flex flex-wrap items-center gap-3">
        <input type="hidden" name="id" value={d.id} />
        <button type="submit" disabled={linking} className="text-small underline underline-offset-4 disabled:opacity-50">
          {d.telegramChatId ? "Make a new Telegram link" : "Make a Telegram link"}
        </button>
        {link.link && (
          <span className="text-small">
            <span className="break-all">{link.link.url}</span>
            {link.link.note && <span className="block text-mute">{link.link.note}</span>}
          </span>
        )}
        {link.error && <span className="text-small font-medium">{link.error}</span>}
      </form>
    </li>
  );
}

export function AddDesignerForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(addDesignerAction, {});
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <label htmlFor="new-name" className={label}>
          Name
        </label>
        <input id="new-name" name="name" required className={input} />
      </div>
      <div>
        <label htmlFor="new-hs" className={label}>
          HubSpot owner ID
        </label>
        <input id="new-hs" name="hubspotOwnerId" inputMode="numeric" className={input} />
      </div>
      <div>
        <label htmlFor="new-cal" className={label}>
          Cal.com user
        </label>
        <input id="new-cal" name="calcomUser" className={input} />
      </div>
      <input type="hidden" name="telegramChatId" value="" />
      <div className="flex items-end gap-3">
        <button type="submit" disabled={pending} className="rounded border border-ink px-3 py-1.5 font-medium disabled:opacity-50">
          Add designer
        </button>
      </div>
      <div className="sm:col-span-2 lg:col-span-4">
        <Status state={state} />
      </div>
    </form>
  );
}
