import { describe, expect, it } from "vitest";
import { agentQuotedPrices, containsPrice, guardFields, guardText, scanForPrices } from "@/lib/guardrail";

describe("no-price guardrail: things that MUST be flagged", () => {
  const bad = [
    "A 2BHK typically costs around ₹15 lakh.",
    "Rates start at Rs. 1,800 per sq ft.",
    "It will be about 12-15 lakh all in.",
    "Budget is 50k for the kitchen.",
    "Our standard spec is 2,400 per sq ft.",
    "per sq ft it is roughly 3000",
    "The range is ₹3.5 lakh to ₹8 lakh.",
    "Approximately five lakh should do it.",
    "Around 2 crore for the villa.",
    "That works out to INR 40000.",
    "Rs 500 per square foot",
    "Premium finish is 2800 psf",
    "It is 3000 rupees a month",
  ];
  for (const t of bad) it(`flags: ${t}`, () => expect(containsPrice(t)).toBe(true));

  it("removes the price and reports what was removed", () => {
    const r = guardText("The designer will quote. Typically ₹15 lakh for this.");
    expect(r.text).toContain("[price removed]");
    expect(r.text).not.toMatch(/15/);
    expect(r.hits.length).toBe(1);
  });

  it("guards every free-text field", () => {
    const { fields, hits } = guardFields(
      { summary: "Wants a 3BHK done. Costs 20 lakh.", reason: null, already_asked: "size", suggested_next_step: "Quote 1800 per sq ft." },
      "",
    );
    expect(fields.summary).toContain("[price removed]");
    expect(fields.suggested_next_step).toContain("[price removed]");
    expect(hits.length).toBe(2);
  });
});

describe("no-price guardrail: things that must NOT be flagged", () => {
  const ok = [
    "Pricing depends on the site, the materials you choose, and the scope.",
    "1,400 sq ft carpet area, 3BHK in Kothrud.",
    "Wants to start in 3 months, finish by March.",
    "Price is driven by custom furniture ratio and material brands.",
    "Caller asked about price per sq ft; not answered. The designer will quote at the consultation.",
    "Office for 20 people, about 800 sq ft.",
    "Possession in 6 weeks.",
  ];
  for (const t of ok) it(`allows: ${t}`, () => expect(scanForPrices(t)).toEqual([]));
});

describe("caller-stated figure exception", () => {
  const transcript = "Agent: Hello.\nCaller: My budget is 1 to 1.5 lakh maximum for everything.";

  it("allows a figure the caller said, when attributed to the caller", () => {
    expect(containsPrice('Caller stated "1 to 1.5 lakh" as budget.', transcript)).toBe(false);
  });
  it("blocks the same figure if it is not attributed to the caller", () => {
    expect(containsPrice("Budget is 1 to 1.5 lakh.", transcript)).toBe(true);
  });
  it("blocks an attributed figure the caller never said", () => {
    expect(containsPrice('Caller stated "20 lakh" as budget.', transcript)).toBe(true);
  });
  it("blocks an attributed figure when there is no transcript to check it against", () => {
    expect(containsPrice('Caller stated "1 to 1.5 lakh" as budget.')).toBe(true);
  });
});

describe("agent breaches are detected in the transcript", () => {
  it("finds a price the voice agent said", () => {
    expect(agentQuotedPrices("Agent: It will cost around 15 lakh.\nCaller: Okay.")).toHaveLength(1);
  });
  it("ignores prices the caller said", () => {
    expect(agentQuotedPrices("Agent: Noted.\nCaller: My budget is 15 lakh.")).toHaveLength(0);
  });
});
