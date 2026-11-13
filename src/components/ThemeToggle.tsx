"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "@/components/ui";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

/** Switches between the dark (Midnight) and light (Navy and gold) themes; remembered in a cookie. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label} className={cx("rounded-md p-2 transition-colors", className)}>
      {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
    </button>
  );
}
