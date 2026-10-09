# HubSpot: setup, behaviour, and the founder dashboard

## 1. Connect

1. In HubSpot, create a **service key** (Settings > Integrations > Service Keys, or Development > Keys). HubSpot is replacing legacy private apps with service keys
   and is switching off the creation of new private apps (from 28 Sept 2026 for new accounts, 26 Oct 2026 for existing ones). A legacy private app's token works the same way if you already have one.
   Give the key these scopes (the exact names in the picker may differ slightly; add any that mention deal or contact objects, schemas or pipelines):
   `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`,
   `crm.schemas.deals.read`, `crm.schemas.deals.write`.
   The app does not use HubSpot webhooks (it polls every 60 seconds), so a service key's lack of webhook support does not matter.
2. Copy the key into `.env` as `HUBSPOT_TOKEN`, add your Hub ID as `HUBSPOT_PORTAL_ID`, and set `HUBSPOT_MODE=live`. It is sent as `Authorization: Bearer <key>`.
3. Restart the app. On startup it creates, if missing:
   - a property group "Aangan Enquiry Desk" on Deals;
   - deal properties `ai_score`, `ai_status`, `ai_reason`, `ai_summary`, `call_transcript_url`, `acknowledged_at`, `acknowledged_by`,
     `call_ai_cost_inr`, `call_telephony_cost_inr`, plus `booked_slot`, `booking_status` and `app_call_id` (the link back to the app);
   - the pipeline **Phone Enquiries** with stages: Yet to be processed, Qualified, Disqualified, Needs attention.
4. For each designer, put their HubSpot owner ID in Settings (so deals are assigned to them, and ownership changes in HubSpot move the call).

The token is used only by server code (`src/lib/hubspot/real.ts`). It is never sent to the browser, and a test fails if any other file reads it.

The API paths used are the `/crm/v3` object, property, pipeline and search endpoints, and `/crm/v4/.../associations/default/...` for linking a deal to a contact.
HubSpot also publishes dated API versions; **these calls have not been run against a real portal yet**, so test with a developer sandbox account first.
HubSpot has announced that support for its v1 to v3 APIs ends in September 2027, so the `/crm/v3` paths in `src/lib/hubspot/real.ts` should be moved to a dated version before then.
Free and Starter HubSpot plans are limited to one deal pipeline, so creating "Phone Enquiries" may be refused there.

## 2. What syncs, and when

| App event | HubSpot |
|---|---|
| Call saved | Contact matched on phone (or created), deal created in **Yet to be processed** |
| AI processing finished | Deal moves to Qualified / Disqualified / Needs attention; score, reason, summary, costs filled in |
| Designer acknowledges | `acknowledged_at` and `acknowledged_by` set |
| Status override | Deal changes stage, `ai_status` updated |
| Booking made, moved or cancelled | `booked_slot`, `booking_status` updated |

- Caller ID withheld: a contact without a phone number is created for that call.
- Same phone number again: the existing contact is reused, and the new call gets its own deal.
- A matched contact named "Unknown caller" gets the name once it is known. A name a person typed is never overwritten.
- Pushes happen straight away. If HubSpot is down, the change is kept and retried every minute. Nothing is lost and the dashboard is never blocked.

### Changes made in HubSpot (read back every 60 seconds)

| In HubSpot | In the app |
|---|---|
| Deal moved to another stage | Status changes; logged as an override with the reason "Changed in HubSpot" |
| `acknowledged_at` set | Call is acknowledged; its reminders are cancelled |
| Deal owner changed | Call is reassigned to that designer; reminders move with it |
| Acknowledgement cleared | Ignored; the app pushes its own value back |
| Moved back to "Yet to be processed" | Ignored for a processed call; the app pushes the real stage back |

If the app has changes it has not yet sent for a call, the app wins for that round.

## 3. Founder dashboard

HubSpot's public API can create dashboards only in a beta, and **cannot create reports** (a report's configuration is not exposed), so a script cannot build this for you.
Run `npm run hubspot:reports` to print the same five numbers from your portal, then build these five reports in the HubSpot UI.
The menu names below are from memory and HubSpot moves things around, so follow the intent if a label differs.

Common settings for every report: data source **Deals**, filter **Pipeline is Phone Enquiries**.

1. **Deals by stage**: Reporting > Reports > Create report > Single object (Deals) > Bar chart. X axis: Deal stage. Y axis: Count of deals.
2. **Disqualified, with reason**: Table report. Extra filter: Deal stage is Disqualified. Columns: Deal name, AI reason, Create date, Deal owner.
3. **Unprocessed count**: Single value (KPI) report. Extra filter: Deal stage is Yet to be processed. Metric: Count of deals.
4. **Time to acknowledge**: Table or average report. Filter: Acknowledged at is known. Add a custom report property or use a calculated property for `acknowledged_at` minus Create date.
   This is wall-clock time. The app's Founder view shows the same measure in working time, which is the one that matches the SLA.
5. **Cost per qualified lead**: Single value or table. Sum of `call_ai_cost_inr` plus Sum of `call_telephony_cost_inr`, divided by the count of deals in stage Qualified.
   HubSpot custom reports cannot divide two aggregates directly, so show the two sums and the qualified count side by side, or use the Founder view for the exact figure.

Then: Reporting > Dashboards > Create dashboard > add the five reports.
