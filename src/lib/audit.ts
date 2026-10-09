import { db, schema } from "@/db";

export async function audit(kind: string, detail: unknown, callId: number | null = null): Promise<void> {
  if (kind.startsWith("mock.")) console.log(`[${kind}]`, JSON.stringify(detail));
  try {
    await db.insert(schema.auditLog).values({ at: new Date(), kind, callId, detail: detail as object });
  } catch (e) {
    // Logging must never break the work it describes.
    console.error("audit log write failed:", e instanceof Error ? e.message : e);
  }
}
