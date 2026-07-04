import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";

import type { GigaamSidecarStatus } from "../types/electron";
import { isGigaamModelReady } from "../utils/gigaamModelStatus";
import { RegularButton } from "../vendor/wallet_animations/components/Button";
import { cn } from "./lib/utils";
import Cell from "../vendor/wallet_animations/components/Cells";
import MotionProvider from "../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../vendor/wallet_animations/components/SectionList";
import StartView from "../vendor/wallet_animations/components/StartView";

const DOWNLOAD_PROGRESS_SHARE = 75;
const INSTALL_PROGRESS_LIMIT = 99;
const INSTALL_PROGRESS_TICK_MS = 600;

interface GigaamModelPreparationStepProps {
  status: GigaamSidecarStatus | null;
  restart: () => void | Promise<unknown>;
  isRestarting?: boolean;
  showReadyAction?: boolean;
  readyActionLabel?: string;
  onReadyAction?: () => void | Promise<void>;
  className?: string;
}

export default function GigaamModelPreparationStep({
  status,
  restart,
  isRestarting = false,
  showReadyAction = false,
  readyActionLabel = "Начать",
  onReadyAction,
  className,
}: GigaamModelPreparationStepProps) {
  const isReady = isGigaamModelReady(status);
  const isError = status?.healthStatus === "error" || status?.modelStage === "error";
  const isInstalling =
    !isReady &&
    !isError &&
    Boolean(status?.available) &&
    (status?.modelStage === "loading" || status?.modelCacheComplete === true);
  const rawProgress = Math.max(0, Math.min(100, status?.modelProgress ?? 0));
  const downloadProgress = Math.floor((rawProgress / 100) * DOWNLOAD_PROGRESS_SHARE);
  const [installProgress, setInstallProgress] = useState(DOWNLOAD_PROGRESS_SHARE);

  useEffect(() => {
    if (!isInstalling) {
      setInstallProgress(DOWNLOAD_PROGRESS_SHARE);
      return undefined;
    }

    setInstallProgress((current) => Math.max(current, DOWNLOAD_PROGRESS_SHARE));

    const interval = window.setInterval(() => {
      setInstallProgress((current) => {
        if (current >= INSTALL_PROGRESS_LIMIT) return current;
        const remaining = INSTALL_PROGRESS_LIMIT - current;
        const step = Math.max(1, Math.ceil(remaining * 0.08));
        return Math.min(INSTALL_PROGRESS_LIMIT, current + step);
      });
    }, INSTALL_PROGRESS_TICK_MS);

    return () => window.clearInterval(interval);
  }, [isInstalling]);

  const progress = useMemo(() => {
    if (isReady) return 100;
    if (isInstalling) return installProgress;
    return Math.min(DOWNLOAD_PROGRESS_SHARE, downloadProgress);
  }, [downloadProgress, installProgress, isInstalling, isReady]);

  const preparationTitle = "Подготавливаем модель";
  const downloadingDescription = "Скачиваем файлы модели. Это нужно только при первом запуске";
  const installingDescription = "Запускаем GigaAM. Обычно это занимает несколько секунд";

  let title = preparationTitle;
  let description = downloadingDescription;

  if (!status) {
    title = preparationTitle;
    description = downloadingDescription;
  } else if (!status.available) {
    title = "GigaAM недоступна";
    description = "Локальная модель доступна только в macOS сборке";
  } else if (isError) {
    title = "Модель не скачалась";
    description = "Попробуйте выключить VPN или сменить Wi-Fi";
  } else if (isReady) {
    title = "Модель готова";
    description = "GigaAM загружена и готова к диктовке";
  } else if (isInstalling) {
    title = preparationTitle;
    description = installingDescription;
  } else if (status.modelStage === "downloading") {
    title = preparationTitle;
    description = downloadingDescription;
  }

  return (
    <AppshotsGigaamModelPanel
      title={title}
      description={description}
      progress={progress}
      isReady={isReady}
      isError={isError}
      isRestarting={isRestarting}
      showReadyAction={showReadyAction}
      readyActionLabel={readyActionLabel}
      onReadyAction={onReadyAction}
      onRetry={restart}
      className={className}
    />
  );
}

interface AppshotsGigaamModelPanelProps {
  title: string;
  description: string;
  progress: number;
  isReady: boolean;
  isError: boolean;
  isRestarting: boolean;
  showReadyAction: boolean;
  readyActionLabel: string;
  onReadyAction?: () => void | Promise<void>;
  onRetry: () => void | Promise<unknown>;
  className?: string;
}

function AppshotsGigaamModelPanel({
  title,
  description,
  progress,
  isReady,
  isError,
  isRestarting,
  showReadyAction,
  readyActionLabel,
  onReadyAction,
  onRetry,
  className,
}: AppshotsGigaamModelPanelProps) {
  const actionLabel = isReady ? readyActionLabel : "Повторить";
  const showAction = (isReady && showReadyAction && onReadyAction) || isError;
  const showReadyButton = isReady && showReadyAction && Boolean(onReadyAction);
  const detailsText = isError ? "Ошибка" : "Модель для распознавания речи";
  const handleAction = () => {
    if (!showAction) return;
    if (isReady) {
      void onReadyAction?.();
    } else {
      void onRetry();
    }
  };
  const handleReadyButtonKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleAction();
  };
  const handleModelCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleAction();
  };
  const canRunModelCardAction = showAction && !isRestarting;

  return (
    <MotionProvider>
      <section
        className={cn(
          "appshots-permissions-no-drag mx-auto w-[460px] py-[20px]",
          isReady && "appshots-gigaam-model-ready",
          className
        )}
      >
        <StartView title={title} description={description} />

        <AnimatePresence mode="wait" initial={false}>
          {showReadyButton ? (
            <m.div
              key="ready-button"
              className="flex justify-center"
              initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -12, filter: "blur(4px)" }}
              transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
            >
              <RegularButton
                variant="filled"
                label={readyActionLabel}
                isShine
                onClick={isRestarting ? undefined : handleAction}
                onKeyDown={isRestarting ? undefined : handleReadyButtonKeyDown}
                role="button"
                tabIndex={isRestarting ? -1 : 0}
                aria-disabled={isRestarting}
              />
            </m.div>
          ) : (
            <m.div
              key="model-card"
              className="appshots-gigaam-model-card"
              initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -12, filter: "blur(4px)" }}
              transition={{ duration: 0.18, ease: [0.4, 0, 1, 1] }}
            >
              <SectionList style={{ gap: 0, padding: 0, paddingBottom: 0 }}>
                <SectionList.Item>
                  <Cell
                    start={<AppshotsGigaamAvatar />}
                    onClick={canRunModelCardAction ? handleAction : undefined}
                    onKeyDown={canRunModelCardAction ? handleModelCardKeyDown : undefined}
                    role={canRunModelCardAction ? "button" : undefined}
                    tabIndex={canRunModelCardAction ? 0 : undefined}
                    end={
                      <Cell.Part type="Picker">
                        {showAction ? actionLabel : `${progress}%`}
                      </Cell.Part>
                    }
                  >
                    <Cell.Text title="GigaAM" description={detailsText} bold />
                  </Cell>
                </SectionList.Item>
              </SectionList>
            </m.div>
          )}
        </AnimatePresence>
      </section>
    </MotionProvider>
  );
}

function AppshotsGigaamAvatar() {
  return (
    <div className="appshots-gigaam-avatar" aria-hidden="true">
      <svg width="40" height="40" viewBox="0 0 100 100" fill="none">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M50 0C77.6122 0 100 22.384 100 50C100 77.6159 77.6122 100 50 100C22.3877 100 0 77.6122 0 50C3.13643e-06 22.3877 22.3877 3.13621e-06 50 0ZM91.1702 37.8824C89.9067 46.6456 85.4519 53.8772 81.7355 58.5829C75.9998 65.6485 68.3154 71.7654 59.4971 76.2858C50.7747 80.7582 41.3392 83.4749 32.213 84.1417C30.6684 84.2306 29.2337 84.2746 27.8889 84.2746C26.2887 84.2746 24.8134 84.2106 23.4131 84.0847C30.7311 89.8169 39.952 93.2346 49.9673 93.2346L49.962 93.2293C73.7688 93.2293 93.0719 73.929 93.0719 50.1222C93.0719 45.9908 92.4892 41.9965 91.4035 38.2136C91.3257 38.1022 91.248 37.99 91.1702 37.8824ZM56.1333 4.56C41.405 4.56 28.0167 10.6339 20.3206 20.8009L20.2719 20.8605C16.9447 24.9138 14.7331 29.3603 13.8807 33.7213C13.3953 36.3742 13.4851 38.8111 14.152 40.9341V40.9288C15.7342 45.679 19.5827 49.4886 23.9476 50.6076C25.763 51.0597 27.5085 51.2487 29.1314 51.1746L29.56 51.1366C40.5945 50.2473 50.4343 43.2929 58.6046 36.6048C63.7178 32.3253 68.6087 26.6633 68.9237 23.0061C61.7945 26.4633 54.4352 30.9611 45.95 37.0415C45.0089 37.7122 43.726 37.5245 43.0257 36.6129C38.8127 31.1587 35.1444 26.7296 31.4723 22.6834C31.0727 22.2389 30.8735 21.6428 30.9327 21.0502C30.9883 20.4574 31.2957 19.9088 31.7735 19.553C43.0228 11.1161 54.2125 6.33568 65.0688 5.32769C62.1572 4.8165 59.1712 4.56007 56.1333 4.56Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}
