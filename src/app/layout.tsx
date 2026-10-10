import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { DesignerSelect } from "@/components/DesignerSelect";
import { activeDesigners } from "@/lib/calls";
import { logoutAction } from "@/app/login/actions";
import { authMode } from "@/lib/auth";
import { currentDesigner, signedIn } from "@/lib/session";

export const metadata = { title: "Aangan Studios Inquiry Tracker" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Signed-out visitors get the sign-in box and nothing else: no navigation, no designer names, no data.
  if (!(await signedIn())) {
    return (
      <html lang="en">
        <body>
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        </body>
      </html>
    );
  }
  const me = await currentDesigner();
  const designers = (await activeDesigners()).map((d) => ({ id: d.id, name: d.name }));
  return (
    <html lang="en">
      <body>
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <span className="font-medium">Aangan Studios Inquiry Tracker</span>
              <Nav />
            </div>
            <div className="flex items-center gap-4">
              <DesignerSelect designers={designers} currentId={me?.id ?? null} />
              {authMode() === "password" && (
                <form action={logoutAction}>
                  <button type="submit" className="text-small text-mute hover:text-ink">
                    Sign out
                  </button>
                </form>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
