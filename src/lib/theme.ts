// Colour theme: "dark" (Midnight, the default) or "light" (Navy and gold). Kept in a cookie so the server
// renders the right theme straight away.

export type Theme = "dark" | "light";

export const THEME_COOKIE = "sl_theme";

export const parseTheme = (raw: string | undefined): Theme => (raw === "light" ? "light" : "dark");
