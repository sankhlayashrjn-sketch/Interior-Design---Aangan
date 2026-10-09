"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/founder", label: "Founder" },
  { href: "/simulate", label: "Simulate call" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-x-5 gap-y-1">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={active ? "font-medium text-ink" : "text-mute hover:text-ink"}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
