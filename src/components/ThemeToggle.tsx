"use client";

import { useEffect, useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

// next-themes reads the OS setting, so the server cannot know which icon to
// draw. `attribute="class"` puts `dark` on <html>, which is what the palette
// in globals.css keys off.
export function Themes({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </ThemeProvider>
  );
}

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-ink-muted"
      // Until the client knows the resolved theme, the label would be a guess.
      aria-label={mounted ? (dark ? "Switch to light mode" : "Switch to dark mode") : "Switch theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {mounted && dark ? <Sun /> : <Moon />}
    </Button>
  );
}
