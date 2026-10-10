import type { ThemeConfig } from "antd";

/** Memphis palette: loud flat colours, black outlines, nothing soft. */
export const M = {
  ink: "#111111",
  cream: "#FFF6DF",
  pink: "#FF5CA8",
  yellow: "#FFD60A",
  teal: "#19C9B0",
  blue: "#3A86FF",
  purple: "#7B2FF7",
  orange: "#FF7A00",
  white: "#FFFFFF",
} as const;

/** The hard offset shadow every Memphis surface wears. */
export const shadow = (px = 4, color: string = M.ink) => `${px}px ${px}px 0 ${color}`;

export const memphisTheme: ThemeConfig = {
  token: {
    colorPrimary: M.purple,
    colorInfo: M.blue,
    colorSuccess: M.teal,
    colorWarning: M.orange,
    colorError: "#E0245E",
    colorText: M.ink,
    colorTextSecondary: "#3d3d57",
    colorBgBase: M.white,
    colorBgLayout: M.cream,
    colorBorder: M.ink,
    colorBorderSecondary: M.ink,
    colorSplit: "rgba(17,17,17,0.18)",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    fontSize: 15,
    borderRadius: 10,
    lineWidth: 2,
    controlHeight: 40,
    boxShadow: "none",
    boxShadowSecondary: shadow(4),
  },
  components: {
    Button: { fontWeight: 700, primaryShadow: shadow(3), defaultShadow: shadow(3), dangerShadow: shadow(3), contentFontSize: 15 },
    Card: { headerBg: M.yellow, headerFontSize: 16, bodyPadding: 18 },
    Tabs: { inkBarColor: M.ink, itemSelectedColor: M.ink, itemHoverColor: M.purple, itemColor: "#3d3d57", titleFontSize: 15, horizontalItemGutter: 28 },
    Table: { headerBg: M.yellow, headerColor: M.ink, headerSplitColor: M.ink, borderColor: M.ink, rowHoverBg: "#FFEFB3", rowExpandedBg: M.white, headerBorderRadius: 10 },
    Collapse: { headerBg: M.white, contentBg: M.white, headerPadding: "12px 16px" },
    Tag: { defaultBg: M.white, defaultColor: M.ink },
    Menu: { itemSelectedColor: M.ink, itemSelectedBg: M.pink, itemHoverBg: M.yellow, itemHoverColor: M.ink, itemColor: M.ink, horizontalItemSelectedColor: M.ink, activeBarHeight: 0, itemBorderRadius: 999 },
    Statistic: { titleFontSize: 14, contentFontSize: 34 },
    Segmented: { itemSelectedBg: M.pink, itemSelectedColor: M.ink, trackBg: M.white, trackPadding: 4 },
    Alert: { colorInfoBg: "#DCEBFF", colorWarningBg: "#FFE9C7" },
  },
};
