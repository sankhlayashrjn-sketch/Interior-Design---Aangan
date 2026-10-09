import { DateTime } from "luxon";
import { agentText, callerText } from "@/lib/guardrail";
import { IST } from "@/lib/working-hours";
import type { AiOutput, ScoreRequest, ScoreResult } from "./schema";

/**
 * Keyword-based stand-in for the model (AI_MODE=mock). It reads the transcript with simple rules so
 * the whole app can run, be demoed and be tested without an API key. It is NOT meant to match the
 * live model's judgement on unusual calls.
 */

const PUNE_AREAS = [
  "pune", "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar", "viman nagar", "hadapsar", "magarpatta",
  "nibm", "kondhwa", "undri", "shivane", "warje", "erandwane", "deccan", "pimpri", "chinchwad", "pimple saudagar",
  "pimple nilakh", "ravet", "hinjewadi", "kharadi", "wagholi", "bavdhan", "pashan", "balewadi", "mundhwa", "karve nagar",
  "katraj", "dhanori", "yerwada", "sus", "camp", "pcmc", "nanded city", "sinhagad road",
];
const OUT_OF_AREA = ["nashik", "mumbai", "talegaon", "lonavala", "lonavla", "nagpur", "hyderabad", "bangalore", "bengaluru", "delhi", "thane", "navi mumbai", "satara", "kolhapur", "goa", "ahmedabad", "chennai"];
const OUT_OF_SCOPE_TYPES = ["restaurant", "hotel", "cafe", "retail", "showroom", "gym", "fitness", "salon", "boutique", "shop", "store"];
const ROOM_WORDS = ["kitchen", "wardrobe", "bedroom", "living", "dining", "bathroom", "study", "balcony", "pooja", "nursery", "kids room", "master", "home office", "workstation", "cabin", "meeting room", "reception", "pantry", "lounge", "boardroom"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const sentenceWith = (text: string, re: RegExp): string | null => {
  const m = new RegExp(String.raw`[^.?!\n]*(?:${re.source})[^.?!]*[.?!]?`, re.flags.replace("g", "")).exec(text);
  if (!m) return null;
  // Drop a leading greeting so the quote starts at the substance. Still a substring of the transcript.
  return m[0]
    .trim()
    .replace(/^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b[\s,.–—-]*/i, "")
    .replace(/^[\s–—-]+/, "")
    .slice(0, 140);
};

const has = (text: string, re: RegExp) => re.test(text);

function parseBudgetLakh(text: string): { lakh: number; quote: string } | null {
  const m = /(\d+(?:\.\d+)?)(?:\s*(?:to|-|–)\s*(\d+(?:\.\d+)?))?\s*(lakhs?|lacs?|crores?)/i.exec(text);
  if (!m) return null;
  const hi = Number(m[2] ?? m[1]);
  const unit = /cr/i.test(m[3]) ? 100 : 1;
  return { lakh: hi * unit, quote: m[0].trim() };
}

export function mockScore(req: ScoreRequest): ScoreResult {
  const transcript = req.transcript ?? "";
  const caller = callerText(transcript).replace(/^caller:\s*/gim, "");
  const agentLines = agentText(transcript);
  const lower = caller.toLowerCase();
  const callerWords = caller.split(/\s+/).filter(Boolean).length;
  const noTranscript = callerWords < 12;
  const NR = "not mentioned";

  // ---- extraction ----
  const nameM = /\b(?:[Ii]'m|[Ii] am|[Tt]his is|[Mm]y name is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(caller);
  const callerName = nameM && !/^(Calling|Looking|Planning|Getting|Opening|In|Hi)$/.test(nameM[1]) ? nameM[1] : null;

  const areaM = [...caller.matchAll(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/gi)].map((m) => ({ n: Number(m[1].replace(/,/g, "")), text: m[0] })).find((a) => a.n >= 50);
  const areaSqft = areaM?.n ?? null;

  const bhk = /(\d)\s*bhk/i.exec(caller);
  const homeOffice = /home office/i.test(caller);
  const commercial = (/\b(office|startup|clinic|coworking|co-working|workstations?|cabin)\b/i.test(caller.replace(/home office/gi, "")) && !bhk) || /commercial/i.test(caller);
  const propertyType: AiOutput["property_type"] = commercial ? "commercial" : bhk || /\b(flat|apartment|villa|house|home|bungalow|room)\b/i.test(caller) ? "residential" : "unknown";

  const rooms = ROOM_WORDS.filter((w) => lower.includes(w));
  const outPlace = OUT_OF_AREA.find((p) => new RegExp(String.raw`\b${p}\b`, "i").test(caller));
  const inPlace = PUNE_AREAS.filter((p) => new RegExp(String.raw`\b${p}\b`, "i").test(caller)).sort((a, b) => b.length - a.length)[0];
  const location = outPlace ? outPlace[0].toUpperCase() + outPlace.slice(1) : inPlace ? inPlace.replace(/\b\w/g, (c) => c.toUpperCase()) : null;

  const scope = rooms.length ? rooms.join(", ") : null;

  // ---- flags ----
  const existingClient = has(caller, /(my designer|project has been going|designer (hasn't|has not) replied|site supervisor)/i);
  const upset = has(caller, /(not acceptable|not a good sign|frustrat|hasn't replied|no one replied|nobody (called|replied)|it's been two days|told someone)/i);
  const proxy = has(caller, /(for my (parents|in-laws|father|mother|mom|dad)|on behalf of|initial (checking|research)|just calling to see if it's worth)/i);

  // ---- clear no (needs an exact quote from the transcript) ----
  let svcNo: string | null = null;
  const adviceQ = sentenceWith(caller, /(just want suggestions|just looking for (ideas|advice)|can someone come and give us some ideas|only (advice|ideas))/i);
  const typeHit = OUT_OF_SCOPE_TYPES.find((t) => new RegExp(String.raw`\b${t}\b`, "i").test(caller));
  if (adviceQ) svcNo = adviceQ;
  else if (typeHit && !bhk) svcNo = sentenceWith(caller, new RegExp(String.raw`\b${typeHit}\b`, "i"));
  else if (commercial && areaSqft !== null && (areaSqft < 500 || areaSqft > 3000)) svcNo = sentenceWith(caller, new RegExp(String.raw`${areaM!.text.replace(/\s+/g, String.raw`\s+`)}`, "i"));
  const locNo = outPlace ? sentenceWith(caller, new RegExp(String.raw`\b${outPlace}\b`, "i")) : null;

  const notALead = has(caller, /(selling|sell you|supplier|vendor|looking for a job|job opening|wrong number)/i)
    ? { evidence: sentenceWith(caller, /(selling|sell you|supplier|vendor|looking for a job|job opening|wrong number)/i) ?? "" }
    : null;

  // ---- criteria ----
  const agentDeclined = has(agentLines, /(not the right fit|outside (our|current)|can't help|we don't (do|work|offer)|below our minimum|i'd suggest (checking|a local|searching)|wouldn't want to bring you|only work in pune)/i);

  const service = svcNo ? { points: 0, evidence: svcNo, clear_no: true } : propertyType !== "unknown" || rooms.length ? { points: 25, evidence: sentenceWith(caller, /(redo|redesign|design|interior|fitout|fit out|office|flat|home)/i) ?? "project described", clear_no: false } : { points: 12, evidence: NR, clear_no: false };

  const bigScope = has(lower, /\b(full|complete|whole|entire|end[- ]to[- ]end)\b/) || (bhk && Number(bhk[1]) >= 2) || (areaSqft ?? 0) >= 700;
  let scalePts = 10;
  let scaleEv = NR;
  if (svcNo && adviceQ) { scalePts = 5; scaleEv = "advice only"; }
  else if (svcNo) { scalePts = typeHit ? 10 : 0; scaleEv = areaM?.text ?? NR; }
  else if (rooms.length >= 3 || (bigScope && rooms.length >= 2)) { scalePts = 20; scaleEv = scope ?? NR; }
  else if (rooms.length >= 2 || bhk) { scalePts = bhk && Number(bhk[1]) >= 3 ? 16 : 14; scaleEv = scope ?? `${bhk?.[0]} flat`; }
  else if (rooms.length === 1) { scalePts = 12; scaleEv = scope ?? NR; }
  if (propertyType === "commercial" && areaSqft && areaSqft >= 500 && areaSqft <= 3000) { scalePts = 20; scaleEv = areaM!.text; }

  const budgetFound = parseBudgetLakh(caller);
  let budgetPts = 8;
  let budgetEv = NR;
  if (budgetFound) {
    budgetEv = budgetFound.quote;
    const floor = ((areaSqft ?? (bhk ? Number(bhk[1]) * 400 : 600)) * 1800) / 100000;
    budgetPts = budgetFound.lakh < floor * 0.5 ? 0 : budgetFound.lakh >= floor * 0.8 ? 15 : 4;
  }

  const locPts = locNo ? { points: 0, evidence: locNo, clear_no: true } : inPlace ? { points: 10, evidence: sentenceWith(caller, new RegExp(String.raw`\b${inPlace}\b`, "i")) ?? inPlace, clear_no: false } : { points: 5, evidence: NR, clear_no: false };

  // timeline
  const callMonth = DateTime.fromJSDate(req.startedAt, { zone: IST }).month - 1;
  const monthMention = MONTHS.map((m, i) => ({ m, i, at: lower.search(new RegExp(String.raw`\b${m}\b`)) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0];
  let timelinePts = 8;
  let timelineEv = NR;
  let timelineText: string | null = null;
  if (has(lower, /before diwali/) && !has(lower, /after diwali/)) { timelinePts = 0; timelineEv = "before Diwali"; timelineText = "before Diwali (about 3 weeks)"; }
  else if (has(lower, /before diwali/) && has(lower, /after diwali/)) { timelinePts = 5; timelineEv = "What if I start after Diwali?"; timelineText = "wanted it before Diwali, open to starting after"; }
  else if (has(lower, /(right away|immediately|start now|as soon as possible|asap)/)) { timelinePts = 15; timelineEv = sentenceWith(caller, /(right away|immediately|start now|as soon as possible)/i) ?? "start now"; timelineText = "wants to start now"; }
  else if (monthMention) {
    const delta = (monthMention.i - callMonth + 12) % 12;
    const completion = has(lower, /(move in|done by|complete|operational|move back|finish)/);
    const start = completion ? delta - 3 : delta;
    timelinePts = start <= 3 ? 15 : start <= 6 ? 10 : 7;
    timelineEv = sentenceWith(caller, new RegExp(monthMention.m, "i")) ?? monthMention.m;
    timelineText = `${completion ? "ready by" : "start"} ${monthMention.m[0].toUpperCase()}${monthMention.m.slice(1)}`;
  } else if (has(lower, /(just exploring|exploring for now|maybe later|just looking)/)) { timelinePts = 7; timelineEv = sentenceWith(caller, /(just exploring|maybe later|just looking)/i) ?? "exploring"; timelineText = "just exploring"; }

  // property + decision maker
  let dmPts = 5;
  let dmEv = NR;
  if (proxy) { dmPts = 3; dmEv = sentenceWith(caller, /(for my (parents|in-laws|father|mother)|initial checking|worth pursuing)/i) ?? "researching for someone else"; }
  else if (has(lower, /(landlord|lease|rented)/)) { dmPts = 10; dmEv = sentenceWith(caller, /(landlord|lease|rented)/i) ?? "rented, landlord fine"; }
  else if (has(lower, /(my husband and i|myself and my husband|we both|i'm the founder|i'm the owner|we bought|my wife and i|possession|i own)/)) { dmPts = 10; dmEv = sentenceWith(caller, /(husband|founder|owner|bought|wife|possession)/i) ?? "owner"; }
  else if (has(lower, /(i run |my (flat|home|house|office))/)) { dmPts = 8; dmEv = sentenceWith(caller, /(i run |my (flat|home|house|office))/i) ?? "own property"; }

  // next step
  let nextPts = 3;
  let nextEv = "wanted a consultation, no slot chosen";
  if (req.bookedSlot) { nextPts = 5; nextEv = "slot booked"; }
  else if (service.clear_no || locPts.clear_no || agentDeclined) { nextPts = 0; nextEv = "call closed as not a fit"; }
  else if (noTranscript) { nextEv = NR; }

  const criteria: AiOutput["criteria"] = noTranscript
    ? {
        service_fit: { points: 12, evidence: NR, clear_no: false },
        scale: { points: 10, evidence: NR, clear_no: false },
        budget: { points: 8, evidence: NR, clear_no: false },
        location: { points: 5, evidence: NR, clear_no: false },
        timeline: { points: 8, evidence: NR, clear_no: false },
        property_dm: { points: 5, evidence: NR, clear_no: false },
        next_step: { points: req.bookedSlot ? 5 : 3, evidence: req.bookedSlot ? "slot booked" : NR, clear_no: false },
      }
    : {
        service_fit: service,
        scale: { points: scalePts, evidence: scaleEv, clear_no: false },
        budget: { points: budgetPts, evidence: budgetEv, clear_no: false },
        location: locPts,
        timeline: { points: timelinePts, evidence: timelineEv, clear_no: false },
        property_dm: { points: dmPts, evidence: dmEv, clear_no: false },
        next_step: { points: nextPts, evidence: nextEv, clear_no: false },
      };

  // ---- handoff note ----
  const asked: string[] = [];
  if (has(agentLines, /(what are you|what's the scope|looking to do|planning)/i)) asked.push("scope");
  if (has(agentLines, /(how big|size|sq ft|how large)/i)) asked.push("size");
  if (has(agentLines, /(timeline|when would|how soon|when do)/i)) asked.push("timeline");
  if (has(agentLines, /(owner|decision|deciding)/i)) asked.push("ownership/decision-maker");
  if (has(agentLines, /(location|where|which area)/i)) asked.push("location");
  const alreadyAsked = asked.length ? asked.join(", ") : "nothing recorded";

  const nameStr = callerName ?? "Caller";
  const where = location ?? "location not stated";
  const what = [propertyType !== "unknown" ? propertyType[0].toUpperCase() + propertyType.slice(1) : null, bhk ? `${bhk[1]}BHK` : null, areaSqft ? `${areaSqft} sq ft` : null].filter(Boolean).join(", ") || "project type not stated";
  const lines: string[] = [];
  if (noTranscript) {
    lines.push(`${nameStr}: call had no usable content (very short, dropped, or missed).`, "No project details were captured.", `Caller ${req.hasPhone ? "can be rung back on the caller ID number" : "withheld caller ID"}.`);
  } else if (existingClient) {
    lines.push(`${nameStr}: existing client raising an issue on a running project.`, "Not a new enquiry. Caller asked for a senior person to call back.", upset ? "Caller is upset about slow replies." : "Handle with care.");
  } else {
    lines.push(`${nameStr}, ${where}. ${what}.${scope ? ` Scope: ${scope}.` : ""}`);
    lines.push(`Timeline: ${timelineText ?? "not stated"}. ${proxy ? "Caller is checking on behalf of family; the decision sits with them." : dmPts >= 8 ? "Caller is deciding (owner or authorised)." : "Ownership and decision-maker not confirmed."}`);
    if (budgetFound) lines.push(`Caller stated "${budgetFound.quote}" as budget; designer to confirm fit at the consultation.`);
    else if (has(lower, /(how much|cost|price|ballpark|rough range|per sq)/)) lines.push("Caller asked about price; it was not given. The designer will quote at the consultation.");
    if (upset) lines.push("Caller is frustrated by an earlier missed follow-up. Call today.");
    if (req.bookedSlot) lines.push("A consultation slot is booked.");
    else if (svcNo || locNo) lines.push(`Likely outside what the studio takes: ${(svcNo ?? locNo ?? "").slice(0, 100)}`);
  }
  const summary = lines.slice(0, 4).join("\n");

  const next = existingClient
    ? "Call back within 15 minutes from a senior person; this is a complaint, not a sales lead."
    : noTranscript
      ? "Ring the caller back and ask what they are planning."
      : svcNo || locNo
        ? "Review the reason. If the call was misjudged, override the status; otherwise close politely."
        : req.bookedSlot
          ? "Confirm the booked slot with the caller and prepare for the consultation."
          : has(lower, /(how much|cost|price|ballpark)/)
            ? "Confirm the consultation and say the designer will walk through pricing there."
            : "Call to confirm a consultation slot.";

  const reason = svcNo ? `Out of scope: ${svcNo.slice(0, 90)}` : locNo ? `Outside service area: ${locNo.slice(0, 90)}` : proxy ? "Researching for someone else; decision-maker not confirmed" : existingClient ? "Existing client with a running project" : noTranscript ? "No usable transcript" : budgetPts === 0 ? "Volunteered budget looks far below the scope described" : timelinePts <= 5 && has(lower, /before diwali/) ? "Timeline conflict: needed it sooner than the studio can deliver, then open to a later start" : timelinePts === 0 ? "Needs it done sooner than the studio can deliver" : null;

  const output: AiOutput = {
    caller_name: callerName,
    location,
    property_type: propertyType,
    area_sqft: areaSqft,
    scope,
    timeline: timelineText,
    budget: budgetFound?.quote ?? null,
    criteria,
    not_a_lead: notALead && notALead.evidence ? notALead : null,
    existing_client: existingClient,
    proxy_no_authority: proxy,
    upset_caller: upset && !existingClient ? true : upset,
    no_transcript: noTranscript,
    reason,
    summary,
    already_asked: alreadyAsked,
    suggested_next_step: next,
  };

  // Rough token estimate so the cost panel has data in mock mode.
  const inputTokens = Math.round((transcript.length + 9000) / 4);
  const outputTokens = Math.round((summary.length + 900) / 4);
  return { output, usage: { inputTokens, outputTokens }, model: "mock-heuristic" };
}
