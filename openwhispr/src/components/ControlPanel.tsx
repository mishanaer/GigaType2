import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, X } from "lucide-react";

import { Button } from "./ui/button";

import PostMigrationOnboarding from "./PostMigrationOnboarding";
import GigaamAsrStatusPanel from "./GigaamAsrStatusPanel";
import GigaamModelPreparationStep from "./GigaamModelPreparationStep";
import SettingsWorkspace from "./SettingsWorkspace";
import { useToast } from "./ui/useToast";
import { useGigaamSidecarStatus } from "../hooks/useGigaamSidecarStatus";
import { useAppshotsAppleSkin } from "../hooks/useAppshotsAppleSkin";
import { shouldShowGigaamModelPreparation } from "../utils/gigaamModelStatus";
import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import { fetchProviders as fetchStreamingProviders } from "../stores/streamingProvidersStore";
import { syncService } from "../services/SyncService.js";

const platform = getCachedPlatform();

export default function ControlPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  useAppshotsAppleSkin();
  const {
    status: gigaamStatus,
    restart: restartGigaam,
    isRestarting: isRestartingGigaam,
  } = useGigaamSidecarStatus();
  const [showPostMigration, setShowPostMigration] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (platform !== "darwin") return;
    window.electronAPI?.getPostMigrationState?.().then((state) => {
      if (state?.justMigrated) setShowPostMigration(true);
    });
  }, []);

  const dismissPostMigrationPermanently = useCallback(async () => {
    await window.electronAPI?.markBundleMigrated?.();
    setShowPostMigration(false);
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [toast, t]);

  useEffect(() => {
    syncService.syncAll().catch(console.error);
  }, []);

  useEffect(() => {
    fetchStreamingProviders();
  }, []);

  const showGigaamPreparation = shouldShowGigaamModelPreparation(gigaamStatus);
  const showGigaamStatusPanel =
    !showGigaamPreparation &&
    Boolean(gigaamStatus?.available && gigaamStatus.healthStatus !== "ok");
  const windowClassName = showGigaamPreparation
    ? "appshots-permissions-window flex w-[500px] flex-col overflow-hidden"
    : "appshots-settings-window flex w-[500px] flex-col overflow-hidden";

  const resizeWindowToContent = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const content = contentRef.current;
      if (!content) return;

      const height = Math.ceil(content.getBoundingClientRect().height);
      window.electronAPI?.resizeControlPanelToContent?.(height, 500)?.catch(() => undefined);
    });
  }, []);

  useLayoutEffect(() => {
    resizeWindowToContent();

    const content = contentRef.current;
    if (!content) {
      return undefined;
    }

    const observer = new ResizeObserver(resizeWindowToContent);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [resizeWindowToContent, showGigaamPreparation, showPostMigration]);

  return (
    <div ref={contentRef} className={windowClassName}>
      <div className="appshots-window-drag-layer" aria-hidden="true" />

      {platform !== "darwin" && (
        <div className="appshots-window-no-drag fixed right-3 top-2 z-50 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => window.electronAPI?.windowMinimize?.()}
            title={t("windowControls.minimize")}
            aria-label={t("windowControls.minimize")}
          >
            <Minus size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => window.electronAPI?.windowClose?.()}
            title={t("windowControls.close")}
            aria-label={t("windowControls.close")}
          >
            <X size={14} />
          </Button>
        </div>
      )}

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      <main className="appshots-window-content flex flex-col">
        {showGigaamPreparation ? (
          <div className="overflow-hidden p-0">
            <div className="mx-auto w-full">
              <GigaamModelPreparationStep
                status={gigaamStatus}
                restart={restartGigaam}
                isRestarting={isRestartingGigaam}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col overflow-hidden">
            {showGigaamStatusPanel && (
              <div className="appshots-settings-no-drag shrink-0 space-y-3 px-[41px] pb-[16px] pt-[24px]">
                <GigaamAsrStatusPanel className="mx-auto w-full max-w-3xl" />
              </div>
            )}

            <div className="overflow-hidden">
              <SettingsWorkspace />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
