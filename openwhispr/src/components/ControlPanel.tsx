import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import PostMigrationOnboarding from "./PostMigrationOnboarding";
import WindowControls from "./WindowControls";
import GigaamAsrStatusPanel from "./GigaamAsrStatusPanel";
import GigaamModelPreparationStep from "./GigaamModelPreparationStep";
import SettingsWorkspace from "./SettingsWorkspace";
import { useToast } from "./ui/useToast";
import { useUpdater } from "../hooks/useUpdater";
import { useGigaamSidecarStatus } from "../hooks/useGigaamSidecarStatus";
import { shouldShowGigaamModelPreparation } from "../utils/gigaamModelStatus";
import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import { fetchProviders as fetchStreamingProviders } from "../stores/streamingProvidersStore";
import { syncService } from "../services/SyncService.js";

const platform = getCachedPlatform();

interface SettingsNavigation {
  section: string;
  requestId: number;
}

export default function ControlPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    status: gigaamStatus,
    restart: restartGigaam,
    isRestarting: isRestartingGigaam,
  } = useGigaamSidecarStatus();
  const { status: updateStatus, isDownloading, error: updateError } = useUpdater();
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState<SettingsNavigation>({
    section: "general",
    requestId: 0,
  });
  const updateReadyToastShown = useRef(false);
  const updateErrorToastShown = useRef<Error | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  const navigateToSettings = useCallback((section = "general") => {
    setSettingsNavigation((current) => ({
      section,
      requestId: current.requestId + 1,
    }));
  }, []);

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
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        navigateToSettings("general");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateToSettings]);

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
    const cleanup = window.electronAPI?.onShowSettings?.(() => {
      navigateToSettings("general");
    });
    return () => cleanup?.();
  }, [navigateToSettings]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      navigateToSettings("general");
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [navigateToSettings, toast, t]);

  useEffect(() => {
    syncService.syncAll().catch(console.error);
  }, []);

  useEffect(() => {
    fetchStreamingProviders();
  }, []);

  const showGigaamPreparation = shouldShowGigaamModelPreparation(gigaamStatus);
  const useAppshotsModelWindow = showGigaamPreparation;
  const useAppshotsSettingsWindow = !showGigaamPreparation;
  const useAppshotsWindow = useAppshotsModelWindow || useAppshotsSettingsWindow;
  const showGigaamStatusPanel =
    !showGigaamPreparation &&
    Boolean(gigaamStatus?.available && gigaamStatus.healthStatus !== "ok");

  const resizeWindowToContent = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const content = contentRef.current;
      if (!content) return;

      const height = Math.ceil(content.getBoundingClientRect().height);
      const width = useAppshotsWindow ? 500 : undefined;
      window.electronAPI?.resizeControlPanelToContent?.(height, width)?.catch(() => undefined);
    });
  }, [useAppshotsWindow]);

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
  }, [resizeWindowToContent, showGigaamPreparation, showPostMigration, useAppshotsWindow]);

  return (
    <div
      ref={contentRef}
      className={
        useAppshotsModelWindow
          ? "appshots-permissions-window flex w-[500px] flex-col overflow-hidden"
          : useAppshotsSettingsWindow
            ? "appshots-settings-window flex w-[500px] flex-col overflow-hidden"
            : "flex flex-col bg-background"
      }
    >
      {useAppshotsWindow && <div className="appshots-window-drag-layer" aria-hidden="true" />}

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      <main className={useAppshotsWindow ? "appshots-window-content flex flex-col" : "flex flex-col"}>
        {!useAppshotsWindow && (
          <div
            className="flex h-10 w-full shrink-0 items-center justify-between"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            <div className="flex-1" />
            {platform !== "darwin" && (
              <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                <WindowControls />
              </div>
            )}
          </div>
        )}

        {showGigaamPreparation ? (
          <div
            className={
              useAppshotsModelWindow ? "overflow-hidden p-0" : "px-6 py-10 md:px-12"
            }
          >
            <div
              className={
                useAppshotsModelWindow
                  ? "mx-auto w-full"
                  : "mx-auto flex w-full max-w-3xl items-center justify-center"
              }
            >
              <GigaamModelPreparationStep
                status={gigaamStatus}
                restart={restartGigaam}
                isRestarting={isRestartingGigaam}
                variant={useAppshotsModelWindow ? "appshots" : "compact"}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col overflow-hidden">
            {showGigaamStatusPanel && (
              <div
                className={
                  useAppshotsSettingsWindow
                    ? "appshots-settings-no-drag shrink-0 space-y-3 px-[41px] pb-[16px] pt-[24px]"
                    : "shrink-0 space-y-3 px-6 pb-3 pt-1"
                }
              >
                <GigaamAsrStatusPanel className="mx-auto w-full max-w-3xl" />
              </div>
            )}

            <div
              className={
                useAppshotsSettingsWindow ? "overflow-hidden" : "border-t border-border/50"
              }
            >
              <SettingsWorkspace
                requestedSection={settingsNavigation.section}
                requestId={settingsNavigation.requestId}
                appearance={useAppshotsSettingsWindow ? "appshots" : "default"}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
