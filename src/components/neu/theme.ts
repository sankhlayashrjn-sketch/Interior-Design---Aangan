import type { ThemeConfig } from "antd";

/**
 * Neumorphism palette. One surface colour; depth comes from shadow, not from colour or borders.
 * The accent colours appear only in small places (dots, text, the primary button) so contrast stays high.
 */
export const N = {
  bg: "#e6eaf1",
  ink: "#25304a",
  mute: "#56617a",
  accent: "#4f5bd5",
  good: "#167a64",
  warn: "#a35d00",
  danger: "#c23556",
  info: "#2563b8",
  dark: "#b9c1d1",
  light: "#ffffff",
} as const;

export const raised = "9px 9px 18px #b9c1d1, -9px -9px 18px #ffffff";
export const raisedSm = "5px 5px 10px #b9c1d1, -5px -5px 10px #ffffff";
export const inset = "inset 6px 6px 12px #b9c1d1, inset -6px -6px 12px #ffffff";
export const insetSm = "inset 3px 3px 6px #b9c1d1, inset -3px -3px 6px #ffffff";

export const neuTheme: ThemeConfig = {
  token: {
    colorPrimary: N.accent,
    colorInfo: N.info,
    colorSuccess: N.good,
    colorWarning: N.warn,
    colorError: N.danger,
    colorText: N.ink,
    colorTextSecondary: N.mute,
    colorBgBase: N.bg,
    colorBgLayout: N.bg,
    colorBgContainer: N.bg,
    colorBgElevated: N.bg,
    colorBorder: "transparent",
    colorBorderSecondary: "rgba(37,48,74,0.14)",
    colorSplit: "rgba(37,48,74,0.14)",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    fontSize: 15,
    borderRadius: 14,
    lineWidth: 0,
    controlHeight: 42,
    boxShadow: raisedSm,
    boxShadowSecondary: raised,
  },
  components: {
    Button: { fontWeight: 600, primaryShadow: raisedSm, defaultShadow: raisedSm, defaultBg: N.bg, defaultColor: N.ink, defaultBorderColor: "transparent", contentFontSize: 15, borderRadius: 14 },
    Card: { headerBg: "transparent" },
    Table: { headerBg: "transparent", headerColor: N.mute, borderColor: "rgba(37,48,74,0.14)", rowHoverBg: "rgba(255,255,255,0.45)", rowExpandedBg: "transparent" },
    Collapse: { headerBg: "transparent", contentBg: "transparent", headerPadding: "14px 18px" },
    Menu: { itemSelectedColor: N.ink, itemColor: N.ink, itemHoverColor: N.ink, horizontalItemSelectedColor: N.ink, itemBorderRadius: 14, itemBg: "transparent" },
    Segmented: { trackBg: N.bg, itemSelectedBg: N.bg, itemSelectedColor: N.ink, itemColor: N.mute, trackPadding: 5 },
    Statistic: { titleFontSize: 13, contentFontSize: 34 },
    Alert: { colorInfoBg: N.bg, colorWarningBg: N.bg },
    Descriptions: { labelBg: "transparent" },
  },
};
