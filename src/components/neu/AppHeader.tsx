"use client";

import { Menu } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const LINKS = [
  { key: "/", href: "/", label: "Front desk" },
  { key: "/designers", href: "/designers", label: "Designers" },
  { key: "/founder", href: "/founder", label: "Founder" },
  { key: "/settings", href: "/settings", label: "Settings" },
];

/** The top bar: one raised slab with the brand, the four sections as pills (the current one pressed in), and who is viewing. */
export function AppHeader({ right }: { right: ReactNode }) {
  const path = usePathname();
  const selected = path === "/" || path.startsWith("/call/") ? "/" : (LINKS.find((l) => l.href !== "/" && path.startsWith(l.href))?.key ?? "");
  return (
    <header className="n-card mx-auto mt-6 max-w-7xl px-6 py-4" style={{ width: "calc(100% - 32px)" }}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="n-inset-sm flex h-11 w-11 items-center justify-center rounded-full" aria-hidden="true">
            <span className="block h-4 w-4 rounded-full bg-accent" />
          </span>
          <div>
            <p className="text-[19px] font-bold leading-tight tracking-tight">Aangan Studios</p>
            <p className="text-small text-mute">Inquiry Tracker</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">{right}</div>
      </div>
      <Menu
        mode="horizontal"
        selectedKeys={[selected]}
        disabledOverflow
        style={{ background: "transparent", borderBottom: 0, marginTop: 14, fontWeight: 600, lineHeight: "40px" }}
        items={LINKS.map((l) => ({ key: l.key, label: <Link href={l.href}>{l.label}</Link> }))}
      />
    </header>
  );
}
