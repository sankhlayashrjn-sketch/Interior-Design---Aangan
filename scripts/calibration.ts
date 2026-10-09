import samples from "@/seed/sample-calls.json";
import { finalizeScore } from "@/lib/rubric";
import { GOLD, toInput } from "../tests/fixtures/gold-scores";

const rows = GOLD.map((g) => {
  const t = samples.find((s) => s.id === g.id)!.transcript;
  const rec = finalizeScore(toInput(g, t));
  const lit = finalizeScore(toInput(g, t), { clearNoCap: 69 });
  return {
    call: g.id,
    "S/Sc/B/L/T/P/N": g.pts.join("/"),
    score: rec.score ?? "-",
    "status (cap 24)": rec.status,
    "status (cap 69)": lit.status,
    note: g.note,
  };
});
console.table(rows);
