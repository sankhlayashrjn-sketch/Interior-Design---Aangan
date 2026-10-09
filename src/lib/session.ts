import { cookies } from "next/headers";
import { activeDesigners, type Designer } from "@/lib/calls";

export const DESIGNER_COOKIE = "designer_id";

/** Demo auth: the selected designer lives in a cookie. Falls back to the first active designer. */
export async function currentDesigner(): Promise<Designer | null> {
  const all = activeDesigners();
  if (all.length === 0) return null;
  const jar = await cookies();
  const id = Number(jar.get(DESIGNER_COOKIE)?.value);
  return all.find((d) => d.id === id) ?? all.find((d) => !d.isEscalation) ?? all[0];
}
