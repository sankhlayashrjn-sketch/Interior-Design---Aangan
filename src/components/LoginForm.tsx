"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/login/actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="password" className="block text-small text-mute">
          Password
        </label>
        <input id="password" name="password" type="password" required autoFocus autoComplete="current-password" className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5" />
      </div>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="rounded bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
          {pending ? "Checking" : "Sign in"}
        </button>
        <p role="alert" className="text-small font-medium">
          {state.error ?? ""}
        </p>
      </div>
    </form>
  );
}
