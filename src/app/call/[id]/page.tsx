import { notFound, redirect } from "next/navigation";
import { db, one, schema } from "@/db";
import { eq } from "drizzle-orm";

/**
 * One stable link for a call, used by Telegram messages and HubSpot. It sends you to the right place: the front
 * desk inbox while nobody has the call, the designer's page once someone does.
 */
export default async function CallLink({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const call = Number.isInteger(id) ? await one(db.select().from(schema.calls).where(eq(schema.calls.id, id))) : undefined;
  if (!call) notFound();
  if (call.assignedDesignerId) redirect(`/designers?who=${call.assignedDesignerId}&tab=${call.acknowledgedAt ? "acknowledged" : "pending"}&open=${id}`);
  redirect(`/?tab=${call.status === "disqualified" ? "disqualified" : "assign"}&open=${id}`);
}
