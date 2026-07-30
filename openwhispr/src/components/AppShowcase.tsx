import React, { useEffect, useState } from "react";

import AppLoadingFallback from "./AppLoadingFallback";
import GigaamModelPreparationStep from "./GigaamModelPreparationStep";
import WalletSettingsCells from "./settings/WalletSettingsCells";
import AppshotsLogoHeader, { AppshotsBuildLabel } from "./ui/AppshotsLogoHeader";
import DailyDictationHeadline from "./ui/DailyDictationHeadline";
import PermissionsSection from "./ui/PermissionsSection";
import { useAppshotsAppleSkin } from "../hooks/useAppshotsAppleSkin";
import type { UsePermissionsReturn } from "../hooks/usePermissions";
import type { GigaamSidecarStatus } from "../types/electron";

const noop = () => undefined;
const noopAsync = async () => undefined;
const totalBytes = 892_000_000;

const permissionSets = {
  fresh: createPermissions(false, false),
  partial: createPermissions(true, false),
  granted: createPermissions(true, true),
};

function createDownloadStatus(progress: number): GigaamSidecarStatus {
  return {
    available: true,
    running: false,
    port: null,
    apiBaseUrl: null,
    healthStatus: "starting",
    modelStage: "downloading",
    modelProgress: progress,
    modelDownloadedBytes: Math.round((totalBytes * progress) / 100),
    modelTotalBytes: totalBytes,
    modelCacheComplete: false,
    modelName: "GigaAM",
  };
}

const gigaamStatuses: Array<{
  title: string;
  description: string;
  status: GigaamSidecarStatus | null;
}> = [
  {
    title: "Memory Load",
    description: "Model files are present; GigaAM is loading into memory.",
    status: {
      available: true,
      running: true,
      port: 38457,
      apiBaseUrl: "http://127.0.0.1:38457",
      healthStatus: "loading",
      modelStage: "loading",
      modelProgress: 99,
      modelDownloadedBytes: totalBytes,
      modelTotalBytes: totalBytes,
      modelCacheComplete: true,
      modelName: "GigaAM e2e RNNT",
    },
  },
  {
    title: "Unavailable",
    description: "Non-Apple-Silicon or unavailable local model state.",
    status: {
      available: false,
      running: false,
      port: null,
      apiBaseUrl: null,
      healthStatus: "unavailable",
      modelStage: "stopped",
      modelProgress: 0,
      modelDownloadedBytes: 0,
      modelTotalBytes: totalBytes,
      modelCacheComplete: false,
      modelName: "GigaAM e2e RNNT",
    },
  },
  {
    title: "Ready",
    description: "Ready state shown at the end of onboarding.",
    status: {
      available: true,
      running: true,
      port: 38457,
      apiBaseUrl: "http://127.0.0.1:38457",
      healthStatus: "ok",
      modelStage: "ready",
      modelProgress: 100,
      modelDownloadedBytes: totalBytes,
      modelTotalBytes: totalBytes,
      modelCacheComplete: true,
      modelName: "GigaAM e2e RNNT",
    },
  },
];

function createPermissions(
  microphoneGranted: boolean,
  accessibilityGranted: boolean
): UsePermissionsReturn {
  return {
    micPermissionGranted: microphoneGranted,
    accessibilityPermissionGranted: accessibilityGranted,
    micPermissionError: null,
    pasteToolsInfo: null,
    isCheckingPasteTools: false,
    requestMicPermission: noopAsync,
    requestAccessibilityPermission: noopAsync,
    checkPasteToolsAvailability: async () => null,
    openMicPrivacySettings: noopAsync,
    openSoundInputSettings: noopAsync,
    setMicPermissionGranted: noop,
    setAccessibilityPermissionGranted: noop,
  };
}

function AnimatedDownloadPreview() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frameId = 0;
    let cycleStartedAt = performance.now();
    const durationMs = 5200;
    const pauseMs = 700;

    const tick = (now: number) => {
      const elapsed = now - cycleStartedAt;

      if (elapsed > durationMs + pauseMs) {
        cycleStartedAt = now;
        setProgress(0);
      } else {
        const t = Math.min(elapsed / durationMs, 1);
        setProgress(Math.min(99, Math.round(t * 99)));
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  return <GigaamModelPreparationStep status={createDownloadStatus(progress)} restart={noop} />;
}

function WindowFrame({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="rounded-[32px] border border-black/10 bg-white/50 p-3 shadow-[0_28px_90px_rgb(15_23_42/0.18)] dark:border-white/10 dark:bg-white/[0.05] dark:shadow-[0_28px_90px_rgb(0_0_0/0.42)]">
      <div className="mb-3 flex items-center justify-between px-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
            {eyebrow}
          </p>
          <h2 className="text-[16px] font-semibold leading-tight text-slate-950 dark:text-slate-100">
            {title}
          </h2>
        </div>
        <div className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
      </div>
      <div className="appshots-showcase-surface mx-auto w-[500px] overflow-hidden rounded-[26px] bg-[rgb(204_208_218/0.9)] text-[var(--tg-theme-text-color)] dark:bg-[rgb(28_28_29/0.92)]">
        {children}
      </div>
    </article>
  );
}

function SettingsPreview() {
  const [hideCapsule, setHideCapsule] = useState(false);
  const [showDockIcon, setShowDockIcon] = useState(true);
  const [audioCuesEnabled, setAudioCuesEnabled] = useState(true);
  const [activationMode, setActivationMode] = useState<"tap" | "push">("push");

  return (
    <div className="mx-auto w-[460px] pb-[24px] pt-[20px]">
      <AppshotsLogoHeader showBuildLabel={false} />
      <DailyDictationHeadline />
      <div className="mt-[24px]">
        <WalletSettingsCells
          dictationKey="CmdOrCtrl+Shift"
          onHotkeyChange={noop}
          activationMode={activationMode}
          onActivationModeChange={setActivationMode}
          preferBuiltInMic={false}
          selectedMicDeviceId=""
          onPreferBuiltInChange={noop}
          onDeviceSelect={noop}
          hideCapsule={hideCapsule}
          onHideCapsuleChange={setHideCapsule}
          showDockIcon={showDockIcon}
          onShowDockIconChange={setShowDockIcon}
          audioCuesEnabled={audioCuesEnabled}
          onAudioCuesEnabledChange={setAudioCuesEnabled}
          devicesOverride={[
            {
              deviceId: "default",
              label: "Системный",
              isBuiltIn: false,
            },
            {
              deviceId: "builtin",
              label: "MacBook Pro Microphone (Built-in)",
              isBuiltIn: true,
            },
          ]}
        />
      </div>
      <AppshotsBuildLabel className="mt-[40px]" size="small" />
    </div>
  );
}

export default function AppShowcase() {
  useAppshotsAppleSkin();
  const isDark = new URLSearchParams(window.location.search).get("theme") === "dark";

  return (
    <div className={isDark ? "dark" : undefined}>
      <div className="min-h-screen bg-[#e9ebf2] px-6 py-10 text-slate-950 dark:bg-[#111217] dark:text-slate-100">
        <header className="mx-auto mb-10 flex max-w-[1120px] items-end justify-between gap-6">
          <div>
            <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
              Type UI
            </p>
            <h1 className="mt-2 text-[40px] font-semibold leading-none tracking-[-0.02em]">
              App Screens
            </h1>
          </div>
          <a
            className="rounded-full bg-slate-950 px-5 py-2 text-[14px] font-medium text-white dark:bg-white dark:text-slate-950"
            href="/?panel=true"
          >
            Open live panel
          </a>
        </header>

        <main className="mx-auto grid max-w-[1120px] grid-cols-1 gap-8 xl:grid-cols-2">
          <WindowFrame eyebrow="Onboarding" title="Permissions: new user">
            <PermissionsSection permissions={permissionSets.fresh} variant="appshots" />
          </WindowFrame>

          <WindowFrame eyebrow="Onboarding" title="Permissions: microphone granted">
            <PermissionsSection permissions={permissionSets.partial} variant="appshots" />
          </WindowFrame>

          <WindowFrame eyebrow="Onboarding" title="Permissions: granted">
            <PermissionsSection permissions={permissionSets.granted} variant="appshots" />
          </WindowFrame>

          <WindowFrame eyebrow="Boot" title="Loading: permissions check">
            <AppLoadingFallback embedded className="h-[360px]" />
          </WindowFrame>

          <WindowFrame eyebrow="Boot" title="Loading: lazy route">
            <AppLoadingFallback embedded className="h-[360px]" />
          </WindowFrame>

          <WindowFrame eyebrow="Settings" title="General settings">
            <SettingsPreview />
          </WindowFrame>

          <WindowFrame eyebrow="GigaAM" title="Download">
            <AnimatedDownloadPreview />
          </WindowFrame>

          {gigaamStatuses.map((item) => (
            <WindowFrame key={item.title} eyebrow="GigaAM" title={item.title}>
              <GigaamModelPreparationStep
                status={item.status}
                restart={noop}
                showReadyAction={item.status?.modelStage === "ready"}
                readyActionLabel="Начать"
                onReadyAction={noop}
              />
            </WindowFrame>
          ))}
        </main>
      </div>
    </div>
  );
}
