"use client";

import { Menu } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Shapes } from "./Shapes";

const LINKS = [
  { key: "/", href: "/", label: "Front desk" },
  { key: "/designers", href: "/designers", label: "Designers" },
  { key: "/founder", href: "/founder", label: "Founder" },
  { key: "/simulate", href: "/simulate", label: "Simulate call" },
  { key: "/settings", href: "/settings", label: "Settings" },
];

/** The banner: yellow, boxed, with the geometric shapes, the five sections as pills, and who is viewing on the right. */
export function AppHeader({ right }: { right: ReactNode }) {
  const path = usePathname();
  const selected = path === "/" || path.startsWith("/call/") ? "/" : (LINKS.find((l) => l.href !== "/" && path.startsWith(l.href))?.key ?? "");
  return (
    <header className="m-banner mx-auto mt-5 max-w-7xl px-5 py-4" style={{ width: "calc(100% - 32px)" }}>
      <Shapes density="light" />
      <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div>
          <p className="text-[22px] font-extrabold leading-tight tracking-tight">Aangan Studios</p>
          <p className="text-small font-semibold">Inquiry Tracker</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">{right}</div>
      </div>
      <Menu
        mode="horizontal"
        selectedKeys={[selected]}
        disabledOverflow
        style={{ background: "transparent", borderBottom: 0, marginTop: 10, fontWeight: 700, lineHeight: "38px" }}
        items={LINKS.map((l) => ({ key: l.key, label: <Link href={l.href}>{l.label}</Link> }))}
      />
    </header>
  );
}
