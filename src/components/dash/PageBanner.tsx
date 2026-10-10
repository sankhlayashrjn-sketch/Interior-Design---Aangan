import type { ReactNode } from "react";

/** A page's title: big white heading, a muted line under it, and room on the right for page-level controls. */
export function PageBanner({ title, subtitle, children }: { title: string; subtitle?: ReactNode; tone?: "pink" | "teal" | "blue" | "yellow"; children?: ReactNode }) {
  return (
    <section className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[30px] font-bold leading-none tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-body text-mute">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
