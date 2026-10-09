import { describe, expect, it } from "vitest";
import samples from "@/seed/sample-calls.json";
import { finalizeScore, quoteIsInTranscript } from "@/lib/rubric";
import { GOLD, toInput } from "./fixtures/gold-scores";

const transcriptOf = (id: string) => samples.find((s) => s.id === id)!.transcript;

describe("calibration against the 20 phone transcripts", () => {
  for (const g of GOLD) {
    it(`${g.id}: ${g.expected} (${g.note})`, async () => {
      const r = finalizeScore(toInput(g, transcriptOf(g.id)));
      expect(r.status).toBe(g.expected);
      if (r.status !== "qualified") expect(r.reason).toBeTruthy();
    });
  }

  it("literal brief reading (cap 69): clear-no calls stay in needs_attention, never disqualified", async () => {
    for (const g of GOLD.filter((x) => x.literal)) {
      const r = finalizeScore(toInput(g, transcriptOf(g.id)), { clearNoCap: 69 });
      expect(r.status).toBe(g.literal);
    }
  });
});

describe("no-auto-reject / disqualification rules", () => {
  const t03 = GOLD.find((g) => g.id === "T03")!;

  it("a clear no whose quote is NOT in the transcript cannot disqualify", async () => {
    const input = toInput(t03, transcriptOf("T03"));
    input.criteria.location.evidence = "caller said they live in Mumbai";
    const r = finalizeScore(input);
    expect(r.status).not.toBe("disqualified");
    expect(r.notes.join(" ")).toMatch(/quote not found/);
  });

  it("a low score without any clear no becomes needs_attention, not disqualified", async () => {
    const input = toInput(GOLD.find((g) => g.id === "T10")!, transcriptOf("T10"));
    for (const k of Object.keys(input.criteria) as (keyof typeof input.criteria)[]) input.criteria[k].points = 2;
    const r = finalizeScore(input);
    expect(r.score!).toBeLessThan(25);
    expect(r.status).toBe("needs_attention");
  });

  it("budget far below scope never disqualifies on its own", async () => {
    expect(finalizeScore(toInput(GOLD.find((g) => g.id === "T10")!, transcriptOf("T10"))).status).toBe("needs_attention");
  });

  it("existing-client complaint is needs_attention with no score", async () => {
    const r = finalizeScore(toInput(GOLD.find((g) => g.id === "T09")!, transcriptOf("T09")));
    expect(r.status).toBe("needs_attention");
    expect(r.score).toBeNull();
  });

  it("a verified not-a-lead is disqualified, an unverified one is ignored", async () => {
    const t = "Agent: Aangan Studio.\nCaller: Hi, I'm calling from a tile supplier to sell you samples.";
    const base = toInput(GOLD.find((g) => g.id === "T01")!, t);
    base.notALead = { evidence: "calling from a tile supplier to sell you samples" };
    expect(finalizeScore(base).status).toBe("disqualified");
    base.notALead = { evidence: "this person is a spammer" };
    expect(finalizeScore(base).status).toBe("qualified");
  });
});

describe("qualified gate", () => {
  const t01 = GOLD.find((g) => g.id === "T01")!;

  it("withheld caller ID and no booking: needs_attention 'No way to reach caller'", async () => {
    const r = finalizeScore(toInput(t01, transcriptOf("T01"), { hasPhone: false, hasBooking: false }));
    expect(r.status).toBe("needs_attention");
    expect(r.reason).toBe("No way to reach caller");
  });

  it("withheld caller ID but a booked slot: still qualified", async () => {
    expect(finalizeScore(toInput(t01, transcriptOf("T01"), { hasPhone: false, hasBooking: true })).status).toBe("qualified");
  });

  it("zero location or service fit can never be qualified", async () => {
    const input = toInput(t01, transcriptOf("T01"));
    input.criteria.location.points = 0;
    expect(finalizeScore(input).status).toBe("needs_attention");
  });

  it("booking a slot does not by itself qualify a weak call", async () => {
    const r = finalizeScore(toInput(GOLD.find((g) => g.id === "T07")!, transcriptOf("T07"), { hasBooking: true }));
    expect(r.status).toBe("needs_attention");
  });

  it("points are clamped to each criterion's maximum", async () => {
    const input = toInput(t01, transcriptOf("T01"));
    input.criteria.service_fit.points = 99;
    expect(finalizeScore(input).breakdown.service_fit.points).toBe(25);
  });
});

describe("quote check", () => {
  it("ignores case, quotes and line wraps", async () => {
    expect(quoteIsInTranscript("a 180 sq ft pod is below our minimum scope", transcriptOf("T18"))).toBe(true);
  });
});
