import { theme, type ThemeConfig } from "antd";

/**
 * Dark dashboard palette with one emerald accent: charcoal page, slightly lighter panels, a soft glow on the active
 * item, and red / amber / green only where they mean something (overdue, needs attention, qualified).
 */
export const N = {
  bg: "#16181b", // page
  side: "#1c1e22", // sidebar
  panel: "#212428", // cards
  panel2: "#292d32", // cards inside cards
  well: "#1a1c20", // inputs and recessed areas
  line: "#2e3238",
  ink: "#f2f4f6", // main text
  mute: "#9097a1", // secondary text (5.6:1 on the panel)
  accent: "#19c37d", // emerald
  accentInk: "#04170e", // text on the accent (8:1)
  good: "#2fdc92",
  warn: "#f5b73b",
  danger: "#ff5d55",
  info: "#5aa9ff",
} as const;

export const glow = "0 0 22px rgba(25,195,125,0.35)";

export const dashTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: N.accent,
    colorInfo: N.info,
    colorSuccess: N.good,
    colorWarning: N.warn,
    colorError: N.danger,
    colorText: N.ink,
    colorTextSecondary: N.mute,
    colorTextPlaceholder: "#6f7680",
    colorBgBase: N.bg,
    colorBgLayout: N.bg,
    colorBgContainer: N.panel,
    colorBgElevated: N.panel2,
    colorBorder: N.line,
    colorBorderSecondary: N.line,
    colorSplit: N.line,
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    fontSize: 15,
    borderRadius: 12,
    controlHeight: 42,
  },
  components: {
    Button: { fontWeight: 600, primaryColor: N.accentInk, defaultBg: N.panel2, defaultColor: N.ink, defaultBorderColor: N.line, borderRadius: 12 },
    Table: { headerBg: "transparent", headerColor: N.mute, borderColor: N.line, rowHoverBg: "rgba(255,255,255,0.03)", rowExpandedBg: "transparent", colorBgContainer: "transparent" },
    Collapse: { headerBg: N.panel2, contentBg: N.panel2, headerPadding: "14px 18px" },
    Segmented: { trackBg: N.well, itemSelectedBg: N.accent, itemSelectedColor: N.accentInk, itemColor: N.mute, trackPadding: 4 },
    Select: { colorBgContainer: N.well },
    Input: { colorBgContainer: N.well },
    Descriptions: { labelBg: "transparent" },
    Alert: { colorWarningBg: "rgba(245,183,59,0.12)", colorInfoBg: "rgba(90,169,255,0.12)" },
  },
};
