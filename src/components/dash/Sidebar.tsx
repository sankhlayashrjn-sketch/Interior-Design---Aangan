"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface Item {
  href: string;
  label: string;
  /** A count shown as a red badge, like unread alerts. */
  badge?: number;
}

/**
 * The left sidebar: who this is, who you are viewing as, the sections in two groups (the current one filled in green
 * with a glow), and sign-out. On a phone it becomes a compact top bar with the same links.
 */
export function Sidebar({ waiting, pending, viewingAs, footer }: { waiting: number; pending: number; viewingAs: ReactNode; footer: ReactNode }) {
  const path = usePathname();
  const current = path === "/" || path.startsWith("/call/") ? "/" : ["/designers", "/founder", "/settings"].find((p) => path.startsWith(p)) ?? "";
  const groups: { label: string; items: Item[] }[] = [
    {
      label: "Calls",
      items: [
        { href: "/", label: "Front desk", badge: waiting },
        { href: "/designers", label: "Designers", badge: pending },
      ],
    },
    {
      label: "Studio",
      items: [
        { href: "/founder", label: "Founder" },
        { href: "/settings", label: "Settings" },
      ],
    },
  ];

  const link = (it: Item) => (
    <Link key={it.href} href={it.href} aria-current={it.href === current ? "page" : undefined}>
      <span>{it.label}</span>
      {it.badge ? <span className="d-badge">{it.badge}</span> : null}
    </Link>
  );

  const brand = (
    <div className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-[15px] font-extrabold text-[#04170e]" aria-hidden="true">
        AS
      </span>
      <div className="min-w-0">
        <p className="truncate text-[16px] font-bold leading-tight">Aangan Studios</p>
        <p className="text-small text-mute">Inquiry Tracker</p>
      </div>
    </div>
  );

  return (
    <>
      <aside className="d-side sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col overflow-y-auto px-4 py-6 lg:flex">
        {brand}
        <div className="mt-6">{viewingAs}</div>
        <nav aria-label="Main" className="d-nav mt-2 flex-1">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="d-nav-label">{g.label}</p>
              <div className="space-y-1">{g.items.map(link)}</div>
            </div>
          ))}
        </nav>
        <div className="mt-6 border-t border-line pt-4">{footer}</div>
      </aside>

      <header className="d-side px-4 py-3 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          {brand}
          <div>{footer}</div>
        </div>
        <div className="mt-3">{viewingAs}</div>
        <nav aria-label="Main" className="d-nav mt-3 flex gap-2 overflow-x-auto pb-1">
          {groups.flatMap((g) => g.items).map((it) => (
            <div key={it.href} className="shrink-0">
              {link(it)}
            </div>
          ))}
        </nav>
      </header>
    </>
  );
}
