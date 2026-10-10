import { M } from "./theme";

/**
 * The Memphis vocabulary: circles, triangles, squiggles, zigzags and dots, in flat colour with black outlines.
 * Purely decorative (aria-hidden) and placed by absolute position, so they never change the layout.
 */
export function Shapes({ density = "full" }: { density?: "full" | "light" }) {
  const stroke = { stroke: M.ink, strokeWidth: 3, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg className="absolute -top-6 right-[8%] hidden sm:block" width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="38" fill={M.pink} {...stroke} />
      </svg>
      <svg className="absolute right-[2%] top-6 hidden md:block" width="70" height="64" viewBox="0 0 70 64">
        <polygon points="35,4 66,60 4,60" fill={M.teal} {...stroke} />
      </svg>
      <svg className="absolute bottom-3 right-[20%] hidden sm:block" width="120" height="26" viewBox="0 0 120 26">
        <path d="M4 13 Q 19 -2 34 13 T 64 13 T 94 13 T 116 13" fill="none" stroke={M.purple} strokeWidth="6" strokeLinecap="round" />
      </svg>
      {density === "full" && (
        <>
          <svg className="absolute left-[44%] top-3 hidden lg:block" width="64" height="30" viewBox="0 0 64 30">
            <path d="M3 25 L 14 5 L 25 25 L 36 5 L 47 25 L 58 5" fill="none" stroke={M.ink} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <svg className="absolute bottom-2 left-[32%] hidden lg:block" width="46" height="46" viewBox="0 0 46 46">
            <rect x="6" y="6" width="34" height="34" rx="4" fill={M.blue} transform="rotate(14 23 23)" {...stroke} />
          </svg>
          <svg className="absolute left-[60%] bottom-5 hidden md:block" width="64" height="24" viewBox="0 0 64 24">
            {[8, 24, 40, 56].map((x) => (
              <circle key={x} cx={x} cy="12" r="5" fill={M.orange} stroke={M.ink} strokeWidth="2.5" />
            ))}
          </svg>
        </>
      )}
    </div>
  );
}
