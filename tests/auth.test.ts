import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Load the auth modules under a given environment (the settings are read once, at import). */
async function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return { auth: await import("@/lib/auth"), proxy: (await import("@/proxy")).proxy };
}
const get = (path: string, cookie?: string) => new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

describe("login gate", () => {
  it("is off on a laptop with no password", async () => {
    const { auth, proxy } = await load({ APP_PASSWORD: "", NODE_ENV: "development" });
    expect(auth.authMode()).toBe("off");
    expect((await proxy(get("/founder"))).status).toBe(200);
  });

  it("locks itself in production when no password is set (never runs open on the internet)", async () => {
    const { auth, proxy } = await load({ APP_PASSWORD: "", NODE_ENV: "production" });
    expect(auth.authMode()).toBe("blocked");
    const res = await proxy(get("/founder"));
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/APP_PASSWORD/);
  });

  it("with a password: pages redirect to /login, API calls get 401, and the login page itself stays reachable", async () => {
    const { proxy } = await load({ APP_PASSWORD: "hunter2", NODE_ENV: "production" });
    const page = await proxy(get("/settings?x=1"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/login?next=%2Fsettings%3Fx%3D1");
    expect((await proxy(get("/api/anything"))).status).toBe(401);
    expect((await proxy(get("/login"))).status).toBe(200);
  });

  it("endpoints that authenticate themselves are not blocked by the login gate", async () => {
    const { proxy } = await load({ APP_PASSWORD: "hunter2", NODE_ENV: "production" });
    for (const p of ["/api/calls", "/api/bookings", "/api/telegram/webhook", "/api/cron/tick"]) expect((await proxy(get(p))).status, p).toBe(200);
  });

  it("a valid session cookie gets through; a forged, tampered or expired one does not", async () => {
    const { auth, proxy } = await load({ APP_PASSWORD: "hunter2", NODE_ENV: "production" });
    const good = await auth.createSession();
    expect((await proxy(get("/founder", `${auth.SESSION_COOKIE}=${good}`))).status).toBe(200);

    const [exp, sig] = good.split(".");
    expect(await auth.verifySession(`${Number(exp) + 99999}.${sig}`)).toBe(false); // changed the expiry
    expect(await auth.verifySession(`${exp}.${"0".repeat(sig.length)}`)).toBe(false); // forged signature
    expect(await auth.verifySession("garbage")).toBe(false);
    expect(await auth.verifySession(undefined)).toBe(false);
    const old = await auth.createSession(Date.now() - auth.SESSION_TTL_MS - 1000);
    expect(await auth.verifySession(old)).toBe(false); // expired
    expect((await proxy(get("/founder", `${auth.SESSION_COOKIE}=${old}`))).status).toBe(307);
  });

  it("a session signed with another password does not work", async () => {
    const a = await load({ APP_PASSWORD: "first", NODE_ENV: "production" });
    const token = await a.auth.createSession();
    const b = await load({ APP_PASSWORD: "second", NODE_ENV: "production" });
    expect(await b.auth.verifySession(token)).toBe(false);
  });

  it("checks the password without leaking where it differs", async () => {
    const { auth } = await load({ APP_PASSWORD: "hunter2", NODE_ENV: "production" });
    expect(await auth.passwordMatches("hunter2")).toBe(true);
    for (const bad of ["", "hunter", "hunter22", "HUNTER2", " hunter2"]) expect(await auth.passwordMatches(bad)).toBe(false);
  });

  it("only redirects to paths on this site after login", async () => {
    const { auth } = await load({ APP_PASSWORD: "x", NODE_ENV: "production" });
    expect(auth.safeNext("/founder?tab=qualified")).toBe("/founder?tab=qualified");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined]) expect(auth.safeNext(bad as string)).toBe("/");
  });
});
