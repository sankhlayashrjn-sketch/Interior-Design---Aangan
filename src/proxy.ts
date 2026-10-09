import { NextResponse, type NextRequest } from "next/server";
import { authMode, isPublicPath, SESSION_COOKIE, verifySession } from "@/lib/auth";

/** The login gate. Runs before every page and server action; API routes that authenticate themselves are skipped. */
export async function proxy(req: NextRequest) {
  const mode = authMode();
  const { pathname, search } = req.nextUrl;
  if (mode === "off" || isPublicPath(pathname)) return NextResponse.next();

  if (mode === "blocked") {
    return new NextResponse("This deployment is locked because APP_PASSWORD is not set. Set APP_PASSWORD (and CRON_SECRET) in the environment and redeploy.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
