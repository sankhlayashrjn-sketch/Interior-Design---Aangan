import { db, schema } from "@/db";

export function audit(kind: string, detail: unknown, callId: number | null = null) {
  db.insert(schema.auditLog).values({ at: new Date(), kind, callId, detail: detail as object }).run();
  if (kind.startsWith("mock.")) console.log(`[${kind}]`, JSON.stringify(detail));
}
