import React from "react";

import SettingsPage, { SettingsSectionType } from "./SettingsPage";
import { SettingsLayoutProvider } from "./ui/useSettingsLayout";

export type { SettingsSectionType };

type SettingsWorkspaceAppearance = "default" | "appshots";

interface SettingsWorkspaceProps {
  requestedSection?: string;
  requestId?: number;
  appearance?: SettingsWorkspaceAppearance;
}

export default function SettingsWorkspace({
  requestedSection: _requestedSection,
  requestId: _requestId,
  appearance = "default",
}: SettingsWorkspaceProps) {
  const [isCompact, setIsCompact] = React.useState(false);
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const isAppshots = appearance === "appshots";

  const containerRef = React.useCallback((el: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsCompact(width > 0 && width < 800);
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return (
    <main
      ref={containerRef}
      className={isAppshots ? "w-full overflow-hidden bg-transparent" : "w-full bg-background"}
    >
      <SettingsLayoutProvider value={{ isCompact }}>
        <div className={isAppshots ? "mx-auto w-[518px] py-[58px]" : isCompact ? "p-4" : "p-6"}>
          <SettingsPage
            activeSection={"general" satisfies SettingsSectionType}
            variant={isAppshots ? "appshots" : "default"}
          />
        </div>
      </SettingsLayoutProvider>
    </main>
  );
}
