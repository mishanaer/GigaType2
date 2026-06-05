import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";

import { Button } from "./ui/button";
import PostMigrationOnboarding from "./PostMigrationOnboarding";
import WindowControls from "./WindowControls";
import GigaamAsrStatusPanel from "./GigaamAsrStatusPanel";
import SettingsWorkspace from "./SettingsWorkspace";
import { useToast } from "./ui/useToast";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
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
  const { useLocalWhisper, localTranscriptionProvider } = useSettings();
  const { status: updateStatus, isDownloading, error: updateError } = useUpdater();
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [settingsNavigation, setSettingsNavigation] = useState<SettingsNavigation>({
    section: "general",
    requestId: 0,
  });
  const [gpuAccelAvailable, setGpuAccelAvailable] = useState<{ cuda: boolean }>({
    cuda: false,
  });
  const [gpuBannerDismissed, setGpuBannerDismissed] = useState(
    () => localStorage.getItem("gpuBannerDismissedUnified") === "true"
  );
  const updateReadyToastShown = useRef(false);
  const updateErrorToastShown = useRef<Error | null>(null);

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
    if (platform === "darwin" || gpuBannerDismissed) return;
    const detect = async () => {
      const results = { cuda: false };
      if (useLocalWhisper && localTranscriptionProvider === "whisper") {
        try {
          const status = await window.electronAPI?.getCudaWhisperStatus?.();
          if (status?.gpuInfo.hasNvidiaGpu && !status.downloaded) results.cuda = true;
        } catch {}
      }
      setGpuAccelAvailable(results);
    };
    detect();
  }, [useLocalWhisper, localTranscriptionProvider, gpuBannerDismissed]);

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
      navigateToSettings("privacyData");
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

  return (
    <div className="flex h-screen flex-col bg-background">
      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 space-y-3 px-6 pb-3 pt-1">
            <GigaamAsrStatusPanel className="mx-auto w-full max-w-3xl" />

            {gpuAccelAvailable.cuda && !gpuBannerDismissed && (
              <div className="mx-auto w-full max-w-3xl">
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 dark:border-primary/15">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 dark:bg-primary/15">
                      <Zap size={16} className="text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="mb-0.5 text-xs font-medium text-foreground">
                        {t("controlPanel.gpu.bannerTitle")}
                      </p>
                      <p className="mb-2 text-xs text-muted-foreground">
                        {t("controlPanel.gpu.bannerDescription")}
                      </p>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => navigateToSettings("transcription")}
                        >
                          {t("controlPanel.gpu.enableButton")}
                        </Button>
                        <button
                          onClick={() => {
                            setGpuBannerDismissed(true);
                            localStorage.setItem("gpuBannerDismissedUnified", "true");
                          }}
                          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {t("controlPanel.gpu.dismissButton")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden border-t border-border/50">
            <SettingsWorkspace
              requestedSection={settingsNavigation.section}
              requestId={settingsNavigation.requestId}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
