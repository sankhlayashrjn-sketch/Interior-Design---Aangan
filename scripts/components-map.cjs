/**
 * Builds the components map (docs/components-map.jpg): one swimlane per actor, one column per stage,
 * dashed arrows between the boxes. Renders HTML in headless Edge, then converts the screenshot to JPEG.
 *   node scripts/components-map.cjs
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const W = 1900;
const LEFT = 230; // actor column width
const TOP = 104; // space above the header band for the title and subtitle
const BAND = 44;
const ROW = 118;
const COLS = ["Trigger", "Input", "Context", "Processing", "AI", "Output"];
const COLW = (W - 130 - LEFT) / COLS.length; // leaves a margin on the right for the arrow that runs down the edge
const BOXH = 82;

const ROWS = [
  { id: "caller", name: "Caller", sub: "(Customer)", bg: "#e9eefb" },
  { id: "vaani", name: "Vaani", sub: "(Voice agent)", bg: "#efe9f8" },
  { id: "code", name: "Code", sub: "(Next.js on Vercel)", bg: "#f2efd8" },
  { id: "gemini", name: "Gemini API", sub: "(Reasoning)", bg: "#f4e6ee" },
  { id: "neon", name: "Neon", sub: "(Call memory)", bg: "#e3efe8" },
  { id: "desk", name: "Front desk", sub: "(FD 1 Gate · FD 2 Badge)", bg: "#e6eef9" },
  { id: "designer", name: "Designer", sub: "(Aryan · Meera · Rohan…)", bg: "#e9eefb" },
  { id: "cal", name: "Cal.com", sub: "(Consultation booking)", bg: "#e4efe6" },
  { id: "hub", name: "HubSpot", sub: "(CRM)", bg: "#f5eadf" },
  { id: "tg", name: "Telegram", sub: "(Reminders)", bg: "#e1f0f0" },
];
const rowIndex = Object.fromEntries(ROWS.map((r, i) => [r.id, i]));
const laneTop = (i) => TOP + BAND + i * ROW;

const KIND = {
  people: { bg: "#dfe6fb", border: "#6f7fc4" },
  code: { bg: "#ece6b4", border: "#a39a3e" },
  ai: { bg: "#f1d3e2", border: "#b86b92" },
  store: { bg: "#cfe3d6", border: "#5f9677" },
  ext: { bg: "#d9e8d6", border: "#6b9a63" },
  lock: { bg: "#dcd8f6", border: "#7c72c9" },
};

// [id, row, column, kind, title, lines]
const BOXES = [
  ["b1", "caller", 0, "people", "Phones the studio", ["any hour · incoming call", "to the Vaani number"]],
  ["b2", "caller", 1, "people", "Talks to the agent", ["project · area · size", "start date · name · email", "day + time they want"]],
  ["b3", "vaani", 2, "ai", "Voice agent answers", ["asks 6 questions, one at a time", "never quotes a price", "design topics only"]],
  ["b4", "vaani", 3, "ext", "Sends the finished call", ["transcript · summary", "name · email · day · time", "→ our webhook (secret key)"]],
  ["b6", "code", 3, "code", "Code does the rules", ["secret check · dedupe on call id", "working hours IST · deadlines", "price guardrail · caller ID"]],
  ["b7", "code", 5, "code", "Scores it in code", ["7 criteria · 100 points", "qualified 70+ · attention 25+", "nobody is auto-rejected"]],
  ["b8", "gemini", 4, "ai", "Reads the transcript", ["name · place · scope · timeline", "a quote as evidence per criterion", "retries once, else a human"]],
  ["b5", "neon", 2, "store", "Stores everything", ["calls · transcripts · notes", "reminders · audit log", "settings · bookings"]],
  ["b9", "desk", 4, "people", "Sees it in the inbox", ["To assign tab · Telegram nudge", "after 1 working hour", "09:00 digest for night calls"]],
  ["b10", "desk", 5, "lock", "Assigns a designer", ["suggested one is pre-picked", "one click, or tap in Telegram", "auto-assigned if nobody does"]],
  ["b11", "designer", 3, "people", "Gets the call", ["Telegram: “assigned to you”", "reads transcript, score,", "recording, booking"]],
  ["b12", "designer", 4, "lock", "Acknowledges", ["within 1 working hour", "can still be moved before this", "status change needs a reason"]],
  ["b13", "cal", 4, "ext", "Books nearest free slot", ["only after a designer is assigned", "invite titled with the designer", "replaced if the call is moved"]],
  ["b14", "cal", 5, "ext", "Invite to the caller", ["email confirmation", "booking shows on the call"]],
  ["b15", "hub", 5, "ext", "Deal in “Phone Enquiries”", ["stage · score · owner · booking", "pushed on every change, stage", "moves read back every minute"]],
  ["b17", "tg", 5, "ext", "Reminders and buttons", ["assign · acknowledge · urgent", "slot alert 30 min before booking", "Assign: front desk · Ack: designer"]],
];

const pos = {};
const boxW = COLW - 40;
for (const [id, row, col] of BOXES) {
  const x = LEFT + 10 + col * COLW + 8;
  const y = laneTop(rowIndex[row]) + (ROW - BOXH) / 2;
  pos[id] = { x, y, w: boxW, h: BOXH, cx: x + boxW / 2, cy: y + BOXH / 2, r: x + boxW, b: y + BOXH };
}

// Anchors
const R = (id) => [pos[id].r, pos[id].cy];
const L = (id) => [pos[id].x, pos[id].cy];
const Tp = (id, ox = 0) => [pos[id].cx + ox, pos[id].y];
const Bt = (id, ox = 0) => [pos[id].cx + ox, pos[id].b];
const RAIL = W - 26;

// [points, label, segment index for the label]
const ARROWS = [
  [[R("b1"), L("b2")], "", 0],
  [[R("b2"), [pos.b3.cx, pos.b2.cy], Tp("b3")], "speaks", 0],
  [[R("b3"), L("b4")], "", 0],
  [[Bt("b4"), Tp("b6")], "webhook", 0],
  [[R("b6"), [pos.b8.cx, pos.b6.cy], Tp("b8")], "transcript", 0],
  [[Bt("b6"), [pos.b6.cx, laneTop(4)], [pos.b5.cx, laneTop(4)], Tp("b5")], "saves", 1],
  [[R("b8"), [pos.b7.cx - 40, pos.b8.cy], Bt("b7", -40)], "structured JSON", 0],
  [[Bt("b7", 40), [pos.b7.cx + 40, laneTop(5)], [pos.b9.cx, laneTop(5)], Tp("b9")], "to assign", 1],
  [[R("b9"), L("b10")], "", 0],
  [[Bt("b10", -40), [pos.b10.cx - 40, laneTop(6)], [pos.b11.cx, laneTop(6)], Tp("b11")], "assigns", 1],
  [[R("b11"), L("b12")], "", 0],
  [[Bt("b10", 40), [pos.b10.cx + 40, laneTop(7)], [pos.b13.cx, laneTop(7)], Tp("b13")], "once assigned", 1],
  [[R("b13"), L("b14")], "", 0],
  [[R("b7"), [RAIL, pos.b7.cy], [RAIL, pos.b15.cy], R("b15")], "every call", 2],
  [[[RAIL, pos.b15.cy], [RAIL, pos.b17.cy], R("b17")], "reminders", 1],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let svg = "";
for (const [pts, label, seg] of ARROWS) {
  svg += `<path d="M${pts.map((p) => p.join(" ")).join(" L")}" fill="none" stroke="#6b5f55" stroke-width="2" stroke-dasharray="7 6" stroke-linejoin="round" marker-end="url(#ah)"/>`;
  const [a, b] = [pts[seg], pts[seg + 1]];
  const lx = (a[0] + b[0]) / 2;
  const ly = (a[1] + b[1]) / 2;
  if (!label) continue;
  const w = label.length * 6.4 + 22;
  svg += `<g><rect x="${lx - w / 2}" y="${ly - 11}" width="${w}" height="22" rx="11" fill="#fff" stroke="#c9c3bb"/><text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#4b443d">${esc(label)}</text></g>`;
}

let lanes = "";
ROWS.forEach((r, i) => {
  lanes += `<div class="lane" style="top:${laneTop(i)}px;height:${ROW}px;background:${r.bg}"></div>`;
  lanes += `<div class="actor" style="top:${laneTop(i)}px;height:${ROW}px"><b>${esc(r.name)}</b><span>${esc(r.sub)}</span></div>`;
});
let heads = COLS.map((c, i) => `<div class="colhead" style="left:${LEFT + 10 + i * COLW}px;width:${COLW}px">${c}</div>`).join("");
let boxes = "";
for (const [id, , , kind, title, lines] of BOXES) {
  const p = pos[id];
  const k = KIND[kind];
  boxes += `<div class="box" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;background:${k.bg};border-color:${k.border}"><h4>${esc(title)}</h4>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`;
}

const legend = [
  ["code", "Code does the rules"],
  ["ai", "AI does the reasoning"],
  ["people", "People decide"],
  ["lock", "Humans lock it in"],
  ["ext", "Connected services"],
  ["store", "Every step is stored"],
];
const H = laneTop(ROWS.length) + 120;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;background:#eef0f7;font-family:"Segoe UI","Inter",Arial,sans-serif;color:#2e2a26;position:relative;overflow:hidden}
.title{position:absolute;top:18px;left:0;right:0;text-align:center}
.title h1{font-size:34px;font-weight:800;letter-spacing:-0.01em}
.title p{margin-top:8px;font-size:17px;color:#554e47}
.band{position:absolute;left:12px;right:12px;top:${TOP}px;height:${BAND}px;background:#6a5849;border-radius:14px 14px 0 0}
.colhead,.actorhead{position:absolute;top:${TOP}px;height:${BAND}px;line-height:${BAND}px;text-align:center;color:#f4ece2;font-weight:700;font-size:17px}
.actorhead{left:12px;width:${LEFT}px}
.lane{position:absolute;left:12px;right:12px}
.actor{position:absolute;left:12px;width:${LEFT}px;background:#6a5849;color:#f7f0e6;display:flex;flex-direction:column;justify-content:center;align-items:center;border-top:2px solid #eef0f7}
.actor b{font-size:21px}.actor span{font-size:13px;opacity:.8;margin-top:3px}
.box{position:absolute;border:2px solid;border-radius:12px;padding:8px 10px;text-align:center;box-shadow:0 2px 6px rgba(60,50,40,.15)}
.box h4{font-size:15px;font-weight:800;margin-bottom:3px}
.box p{font-size:11.6px;line-height:1.35;color:#3d372f}
svg.arrows{position:absolute;left:0;top:0}
.legend{position:absolute;left:0;right:0;bottom:46px;display:flex;justify-content:center;gap:14px;flex-wrap:wrap}
.legend span{border:2px solid;border-radius:999px;padding:7px 18px;font-size:14px;font-weight:600;color:#3b352e}
.foot{position:absolute;left:0;right:0;bottom:16px;text-align:center;font-size:12.5px;color:#6b645c}
</style></head><body>
<div class="title"><h1>Aangan Studios Inquiry Tracker — Components Map</h1><p>One phone call → scored by AI + rules → front desk assigns → designer acknowledges → consultation booked → CRM and Telegram stay in step</p></div>
<div class="band"></div><div class="actorhead">Actor</div>${heads}
${lanes}
<svg class="arrows" width="${W}" height="${H}"><defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#6b5f55"/></marker></defs>${svg}</svg>
${boxes}
<div class="legend">${legend.map(([k, t]) => `<span style="background:${KIND[k].bg};border-color:${KIND[k].border}">${t}</span>`).join("")}</div>
<div class="foot">Stack: Next.js on Vercel · Neon (Postgres) · Google Gemini · Vaani voice agent · Cal.com · HubSpot · Telegram · GitHub Actions timer (every 5 minutes)</div>
</body></html>`;

const out = path.join(__dirname, "..", "docs");
fs.mkdirSync(out, { recursive: true });
const htmlFile = path.join(os.tmpdir(), "components-map.html");
const png = path.join(os.tmpdir(), "components-map.png");
fs.writeFileSync(htmlFile, html);
fs.writeFileSync(path.join(out, "components-map.html"), html);
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.5", `--window-size=${W},${H}`, `--screenshot=${png}`, "file:///" + htmlFile.replace(/\\/g, "/")], { stdio: "ignore", timeout: 90_000 });
require("sharp")(png)
  .jpeg({ quality: 92 })
  .toFile(path.join(out, "components-map.jpg"))
  .then((i) => console.log("wrote docs/components-map.jpg", i.width + "x" + i.height));
