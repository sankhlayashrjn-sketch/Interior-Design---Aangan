import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "./globals.css";
import { DesignerSelect } from "@/components/DesignerSelect";
import { DashProvider } from "@/components/dash/Provider";
import { Sidebar } from "@/components/dash/Sidebar";
import { activeDesigners, countsForDesigner, countsForFrontDesk } from "@/lib/calls";
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
          <DashProvider>
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
          </DashProvider>
        </body>
      </html>
    );
  }
  const me = await currentDesigner();
  const designers = (await activeDesigners()).map((d) => ({ id: d.id, name: d.role === "front_desk" ? `${d.name} (front desk)` : d.name }));
  const [front, desks] = await Promise.all([countsForFrontDesk(), countsForDesigner("all")]);
  return (
    <html lang="en">
      <body>
        <DashProvider>
          <div className="min-h-screen lg:flex">
            <Sidebar
              waiting={front.assign}
              pending={desks.pending}
              viewingAs={<DesignerSelect designers={designers} currentId={me?.id ?? null} />}
              footer={
                authMode() === "password" ? (
                  <form action={logoutAction}>
                    <button type="submit" className="text-small font-semibold text-mute underline underline-offset-4 hover:text-ink">
                      Sign out
                    </button>
                  </form>
                ) : (
                  <p className="text-small text-mute">Aangan Studio, Pune</p>
                )
              }
            />
            <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-9 lg:py-8">{children}</main>
          </div>
        </DashProvider>
      </body>
    </html>
  );
}
