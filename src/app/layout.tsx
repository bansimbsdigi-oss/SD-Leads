import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Fira_Code, Plus_Jakarta_Sans } from "next/font/google";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-ui-sans", display: "swap" });
const firaCode = Fira_Code({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-fira-code", display: "swap" });

export const metadata: Metadata = {
  title: "Sabhi Leads",
  description: "Lead management for Sabhi Digital and its clients",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} className={`${jakarta.variable} ${firaCode.variable}`}>
      <body>{children}</body>
    </html>
  );
}
