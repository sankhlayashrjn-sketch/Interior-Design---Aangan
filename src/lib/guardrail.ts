/**
 * Output guardrail: no price, per-sq-ft rate, range or estimate may appear in text the AI generates.
 *
 * One narrow exception: a figure the CALLER said, repeated for the designer's benefit, is allowed
 * when it appears word for word in the transcript AND the sentence attributes it to the caller
 * ("caller stated ..."). Anything else is replaced with [price removed] and reported.
 */

export interface PriceHit {
  match: string;
  index: number;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const WORD_NUM = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|twenty[- ]five|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)`;
const UNIT = String.raw`(?:lakhs?|lacs?|lakh|crores?|cr|crs|k|thousand|million|mn)`;
const PER_SQFT = String.raw`(?:per\s*sq\.?\s*(?:ft|feet|foot)|\/\s*sq\.?\s*(?:ft|feet)|\bpsf\b|per\s*square\s*(?:feet|foot)|per\s*sqft)`;

const PATTERNS: RegExp[] = [
  // Currency symbol or code followed by an amount: ₹5,00,000  Rs. 3.5  INR 40000
  new RegExp(String.raw`(?:₹|\brs\.?|\binr\b|\brupees?\b)\s*${NUM}(?:\s*(?:-|–|to)\s*${NUM})?(?:\s*${UNIT}\b)?`, "gi"),
  // Amount followed by a money unit: 15 lakh, 1-1.5 lakh, 2 crore, 50k
  new RegExp(String.raw`\b${NUM}(?:\s*(?:-|–|to)\s*${NUM})?\s*${UNIT}\b`, "gi"),
  // Spelled-out: five lakh, two crore
  new RegExp(String.raw`\b${WORD_NUM}(?:\s*(?:-|–|to)\s*${WORD_NUM})?\s*(?:lakhs?|lacs?|crores?)\b`, "gi"),
  // Rupee amount after the word: 3000 rupees
  new RegExp(String.raw`\b${NUM}\s*(?:rupees?|rs\b|inr\b)`, "gi"),
  // A rate: a number within a few characters of "per sq ft"
  new RegExp(String.raw`${NUM}\s*(?:₹|rs\.?|inr)?\s*${PER_SQFT}`, "gi"),
  // "per sq ft ... 3000": a 3+ digit figure shortly after the phrase (not 3BHK, 3 months, ...)
  new RegExp(String.raw`${PER_SQFT}[^\d.\n]{0,25}\d[\d,]{2,}(?:\.\d+)?(?!\s*(?:bhk|months?|weeks?|rooms?|days?|people|sq))`, "gi"),
];

export function scanForPrices(text: string): PriceHit[] {
  const hits: PriceHit[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      const end = index + m[0].length;
      // Drop hits wholly contained in a hit we already have.
      if (hits.some((h) => h.index <= index && h.index + h.match.length >= end)) continue;
      for (let i = hits.length - 1; i >= 0; i--) {
        if (index <= hits[i].index && end >= hits[i].index + hits[i].match.length) hits.splice(i, 1);
      }
      hits.push({ match: m[0].trim(), index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("\n", index)) + 1;
  const nextDot = text.indexOf(".", index);
  const nextNl = text.indexOf("\n", index);
  const ends = [nextDot, nextNl].filter((n) => n >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

export interface Turn {
  speaker: "caller" | "agent";
  text: string;
}

/** Split a transcript into turns. Lines without a speaker prefix continue the previous turn (transcripts wrap long turns). */
export function splitTurns(transcript: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of transcript.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(caller|user|customer|agent|front desk|assistant|ai)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const speaker = /^(caller|user|customer)$/i.test(m[1]) ? "caller" : "agent";
      turns.push({ speaker, text: m[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += " " + line;
    }
  }
  return turns;
}

/** What the caller said, one turn per line, without speaker labels. */
export function callerText(transcript: string): string {
  return splitTurns(transcript).filter((t) => t.speaker === "caller").map((t) => t.text).join("\n");
}

/** What the agent said, one turn per line, without speaker labels. */
export function agentText(transcript: string): string {
  return splitTurns(transcript).filter((t) => t.speaker === "agent").map((t) => t.text).join("\n");
}

function isAllowedCallerFigure(text: string, hit: PriceHit, transcript: string): boolean {
  const sentence = sentenceAround(text, hit.index);
  if (!/\bcaller\s+(?:stated|said|mentioned|quoted|volunteered)\b/i.test(sentence)) return false;
  return squash(callerText(transcript)).includes(squash(hit.match));
}

export interface GuardResult {
  text: string;
  /** The matches that were removed. */
  hits: string[];
}

/** Remove any price from generated text. `transcript` enables the caller-stated exception. */
export function guardText(text: string, transcript = ""): GuardResult {
  const hits = scanForPrices(text).filter((h) => !isAllowedCallerFigure(text, h, transcript));
  if (hits.length === 0) return { text, hits: [] };
  let out = text;
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, h.index) + "[price removed]" + out.slice(h.index + h.match.length);
  }
  return { text: out, hits: hits.map((h) => h.match) };
}

/** True if any price would be flagged in this text. Used on text meant to be spoken to a caller. */
export function containsPrice(text: string, transcript = ""): boolean {
  return guardText(text, transcript).hits.length > 0;
}

/** Prices the voice agent itself said in the transcript. These are rule breaches by the agent, so they are flagged for review. */
export function agentQuotedPrices(transcript: string): string[] {
  // Repeating a figure the caller gave is not quoting a price.
  const said = squash(callerText(transcript));
  return scanForPrices(agentText(transcript))
    .map((h) => h.match)
    .filter((m) => !said.includes(squash(m)));
}

export interface TextFields {
  summary: string;
  reason: string | null;
  already_asked: string;
  suggested_next_step: string;
}

/** Apply the guardrail to every free-text field the AI generated. */
export function guardFields<T extends Partial<TextFields>>(fields: T, transcript: string): { fields: T; hits: string[] } {
  const out = { ...fields };
  const hits: string[] = [];
  for (const key of ["summary", "reason", "already_asked", "suggested_next_step"] as const) {
    const v = out[key];
    if (typeof v === "string") {
      const g = guardText(v, transcript);
      (out as Record<string, unknown>)[key] = g.text;
      hits.push(...g.hits);
    }
  }
  return { fields: out, hits };
}
