import type { Metadata } from "next";
import { Fira_Code, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-ui-sans", display: "swap" });
const firaCode = Fira_Code({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-fira-code", display: "swap" });

export const metadata: Metadata = {
  title: "Sabhi Leads",
  description: "Lead management for Sabhi Digital and its clients",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${jakarta.variable} ${firaCode.variable}`}>
      <body>{children}</body>
    </html>
  );
}
