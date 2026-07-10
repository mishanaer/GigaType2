import { useEffect } from "react";
import { useSettings } from "./useSettings";
import { getCachedPlatform } from "../utils/platform";

// Windows always uses the light theme (#11). The main process already forces
// nativeTheme.themeSource = "light" there; this guard keeps the renderer light
// even if nativeTheme gets re-flipped later.
const FORCE_LIGHT = getCachedPlatform() === "win32";

export function useTheme() {
  const { theme, setTheme } = useSettings();

  useEffect(() => {
    const htmlElement = document.documentElement;

    // Determine effective theme
    const effectiveTheme: "light" | "dark" = FORCE_LIGHT
      ? "light"
      : theme === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    // Apply dark class
    if (effectiveTheme === "dark") {
      htmlElement.classList.add("dark");
      document.body.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
      document.body.classList.remove("dark");
    }

    // Listen for system preference changes (only when auto)
    if (theme === "auto" && !FORCE_LIGHT) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        if (e.matches) {
          htmlElement.classList.add("dark");
          document.body.classList.add("dark");
        } else {
          htmlElement.classList.remove("dark");
          document.body.classList.remove("dark");
        }
      };

      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [theme]);

  return { theme, setTheme };
}
