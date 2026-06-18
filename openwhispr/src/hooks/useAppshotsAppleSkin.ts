import { useLayoutEffect } from "react";

let activeScopes = 0;
let hadAppleBeforeAppshots = false;
let hadMaterialBeforeAppshots = false;

export function useAppshotsAppleSkin() {
  useLayoutEffect(() => {
    if (typeof document === "undefined") return undefined;

    if (activeScopes === 0) {
      hadAppleBeforeAppshots = document.body.classList.contains("apple");
      hadMaterialBeforeAppshots = document.body.classList.contains("material");
      document.body.classList.remove("material");
      document.body.classList.add("apple");
    }

    activeScopes += 1;

    return () => {
      activeScopes = Math.max(0, activeScopes - 1);
      if (activeScopes > 0) return;

      if (!hadAppleBeforeAppshots) {
        document.body.classList.remove("apple");
      }
      if (hadMaterialBeforeAppshots) {
        document.body.classList.add("material");
      }
    };
  }, []);
}
