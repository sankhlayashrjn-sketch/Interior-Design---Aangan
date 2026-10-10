import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "./globals.css";
import { DesignerSelect } from "@/components/DesignerSelect";
import { AppHeader } from "@/components/memphis/AppHeader";
import { MemphisProvider } from "@/components/memphis/Provider";
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
          <MemphisProvider>
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
          </MemphisProvider>
        </body>
      </html>
    );
  }
  const me = await currentDesigner();
  const designers = (await activeDesigners()).map((d) => ({ id: d.id, name: d.role === "front_desk" ? `${d.name} (front desk)` : d.name }));
  return (
    <html lang="en">
      <body>
        <MemphisProvider>
          <AppHeader
            right={
              <>
                <DesignerSelect designers={designers} currentId={me?.id ?? null} />
                {authMode() === "password" && (
                  <form action={logoutAction}>
                    <button type="submit" className="text-small font-bold underline underline-offset-4">
                      Sign out
                    </button>
                  </form>
                )}
              </>
            }
          />
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        </MemphisProvider>
      </body>
    </html>
  );
}
