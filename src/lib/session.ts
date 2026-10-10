import { cookies } from "next/headers";
import { authMode, SESSION_COOKIE, verifySession } from "@/lib/auth";
import type { Role } from "@/db/schema";
import { activeDesigners, type Designer } from "@/lib/calls";

export const DESIGNER_COOKIE = "designer_id";

/** Demo auth: the selected designer lives in a cookie. Falls back to the first active designer. */
export async function currentDesigner(): Promise<Designer | null> {
  const all = await activeDesigners();
  if (all.length === 0) return null;
  const jar = await cookies();
  const id = Number(jar.get(DESIGNER_COOKIE)?.value);
  return all.find((d) => d.id === id) ?? all.find((d) => !d.isEscalation) ?? all[0];
}

/** The chosen person if they have this role, otherwise the first active person who does. Null if nobody has the role. */
export async function currentPerson(role: Role): Promise<Designer | null> {
  const all = (await activeDesigners()).filter((d) => d.role === role);
  const jar = await cookies();
  const id = Number(jar.get(DESIGNER_COOKIE)?.value);
  return all.find((d) => d.id === id) ?? all.find((d) => !d.isEscalation) ?? all[0] ?? null;
}

/** Is the visitor allowed to see the app? (No login needed in development, a valid session cookie otherwise.) */
export async function signedIn(): Promise<boolean> {
  const mode = authMode();
  if (mode === "off") return true;
  if (mode === "blocked") return false;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}
