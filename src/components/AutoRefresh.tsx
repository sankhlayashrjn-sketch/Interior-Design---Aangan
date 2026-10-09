"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page on an interval so "due in" and "overdue" stay current and new calls appear. */
export function AutoRefresh({ everyMs = 30_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
