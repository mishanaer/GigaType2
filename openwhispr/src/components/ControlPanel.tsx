import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import PostMigrationOnboarding from "./PostMigrationOnboarding";
import GigaamAsrStatusPanel from "./GigaamAsrStatusPanel";
import GigaamModelPreparationStep from "./GigaamModelPreparationStep";
import SettingsWorkspace from "./SettingsWorkspace";
import { useToast } from "./ui/useToast";
import { useUpdater } from "../hooks/useUpdater";
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
  const { status: updateStatus, isDownloading, error: updateError } = useUpdater();
  const [showPostMigration, setShowPostMigration] = useState(false);
  const updateReadyToastShown = useRef(false);
  const updateErrorToastShown = useRef<Error | null>(null);
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
    if (updateStatus.updateDownloaded && !isDownloading) {
      if (!updateReadyToastShown.current) {
        updateReadyToastShown.current = true;
        toast({
          title: t("controlPanel.update.readyTitle"),
          description: t("controlPanel.update.readyDescription"),
          variant: "success",
        });
      }
    } else {
      updateReadyToastShown.current = false;
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    if (updateError && updateError !== updateErrorToastShown.current) {
      updateErrorToastShown.current = updateError;
      toast({
        title: t("controlPanel.update.problemTitle"),
        description: t("controlPanel.update.problemDescription"),
        variant: "destructive",
      });
    }
    if (!updateError) {
      updateErrorToastShown.current = null;
    }
  }, [updateError, toast, t]);

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
