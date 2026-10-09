"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authMode, createSession, passwordMatches, safeNext, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  if (authMode() !== "password") redirect("/");
  if (!(await passwordMatches(String(form.get("password") ?? "")))) {
    await new Promise((r) => setTimeout(r, 700)); // a wrong guess costs a moment, which slows guessing down
    return { error: "That password is not right." };
  }
  (await cookies()).set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect(safeNext(String(form.get("next") ?? "/")));
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
