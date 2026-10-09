import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { AddDesignerForm, DesignerRow, SettingsForm } from "@/components/SettingsForms";
import { integrationStatus } from "@/lib/env";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await getSettings();
  const designers = await db.select().from(schema.designers).orderBy(asc(schema.designers.rrOrder), asc(schema.designers.id));

  const integrations = integrationStatus(); // whether a key is set, never its value

  return (
    <div className="max-w-4xl">
      <h1 className="mb-8 text-title font-medium">Settings</h1>

      <section aria-labelledby="hours" className="mb-12">
        <h2 id="hours" className="mb-4 text-small font-medium text-mute">
          Hours, SLA and AI model
        </h2>
        <SettingsForm s={{ workStart: s.workStart, workEnd: s.workEnd, workDays: s.workDays, holidays: s.holidays, slaMinutes: s.slaMinutes, slotAlertMinutes: s.slotAlertMinutes, aiModel: s.aiModel }} />
      </section>

      <section aria-labelledby="designers" className="mb-12">
        <h2 id="designers" className="text-small font-medium text-mute">
          Designers
        </h2>
        <p className="mt-1 text-small text-mute">New calls rotate through everyone who takes new calls, in this order. The studio head gets complaints and a copy of urgent alerts.</p>
        <ul className="mt-2 border-t border-line">
          {designers.map((d) => (
            <DesignerRow key={d.id} d={{ id: d.id, name: d.name, telegramChatId: d.telegramChatId, hubspotOwnerId: d.hubspotOwnerId, calcomUser: d.calcomUser, active: d.active, isEscalation: d.isEscalation }} />
          ))}
        </ul>
        <div className="mt-6">
          <h3 className="mb-3 text-small font-medium text-mute">Add a designer</h3>
          <AddDesignerForm />
        </div>
      </section>

      <section aria-labelledby="integrations">
        <h2 id="integrations" className="mb-3 text-small font-medium text-mute">
          Integrations (set in the environment file, then restart)
        </h2>
        <table className="w-full max-w-xl text-left">
          <thead className="sr-only">
            <tr>
              <th>Integration</th>
              <th>Mode</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map((i) => (
              <tr key={i.name} className="border-t border-line first:border-t-0">
                <td className="py-2 pr-6">{i.name}</td>
                <td className="py-2 pr-6 font-medium">{i.live ? "Live" : "Mock"}</td>
                <td className="py-2 text-small text-mute">{i.keySet ? "Key is set" : i.live ? `Missing: ${i.needs}` : "No key needed in mock mode"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
