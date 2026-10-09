import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { DesignerSelect } from "@/components/DesignerSelect";
import { activeDesigners } from "@/lib/calls";
import { currentDesigner } from "@/lib/session";

export const metadata = { title: "Aangan Enquiry Desk" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await currentDesigner();
  const designers = activeDesigners().map((d) => ({ id: d.id, name: d.name }));
  return (
    <html lang="en">
      <body>
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <span className="font-medium">Aangan Enquiry Desk</span>
              <Nav />
            </div>
            <DesignerSelect designers={designers} currentId={me?.id ?? null} />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
