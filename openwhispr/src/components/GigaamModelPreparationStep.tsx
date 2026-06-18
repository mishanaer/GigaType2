import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import type { KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";

import type { GigaamSidecarStatus } from "../types/electron";
import { isGigaamModelReady } from "../utils/gigaamModelStatus";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { RegularButton } from "../vendor/wallet_animations/components/Button";
import { cn } from "./lib/utils";
import Cell from "../vendor/wallet_animations/components/Cells";
import MotionProvider from "../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../vendor/wallet_animations/components/SectionList";
import StartView from "../vendor/wallet_animations/components/StartView";

type GigaamModelPreparationVariant = "compact" | "appshots";

interface GigaamModelPreparationStepProps {
  status: GigaamSidecarStatus | null;
  restart: () => void | Promise<unknown>;
  isRestarting?: boolean;
  showReadyAction?: boolean;
  readyActionLabel?: string;
  onReadyAction?: () => void | Promise<void>;
  className?: string;
  variant?: GigaamModelPreparationVariant;
}

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "0 МБ";
  const mb = bytes / 1_000_000;
  if (mb < 1000) return `${Math.round(mb)} МБ`;
  return `${(mb / 1000).toFixed(1)} ГБ`;
}

export default function GigaamModelPreparationStep({
  status,
  restart,
  isRestarting = false,
  showReadyAction = false,
  readyActionLabel = "Начать",
  onReadyAction,
  className,
  variant = "compact",
}: GigaamModelPreparationStepProps) {
  const isReady = isGigaamModelReady(status);
  const isError = status?.healthStatus === "error" || status?.modelStage === "error";
  const progress = isReady
    ? 100
    : Math.max(0, Math.min(99, Math.floor(status?.modelProgress ?? 0)));
  const downloadedBytes = isReady ? status?.modelTotalBytes : status?.modelDownloadedBytes;
  const totalBytes = status?.modelTotalBytes;

  const downloadingTitle = "Скачиваем модель";
  const downloadingDescription = "Это нужно только при первом запуске";

  let title = downloadingTitle;
  let description = downloadingDescription;

  if (!status) {
    title = downloadingTitle;
    description = downloadingDescription;
  } else if (!status.available) {
    title = "GigaAM недоступна";
    description = "Локальная модель доступна только в macOS сборке для Apple Silicon";
  } else if (isError) {
    title = "Не удалось подготовить модель";
    description = status.healthDetail || "Проверьте подключение к интернету и попробуйте ещё раз";
  } else if (isReady) {
    title = "Модель готова";
    description = "GigaAM загружена и готова к диктовке";
  } else if (status.modelStage === "loading" || status.modelCacheComplete) {
    title = "Загружаем модель в память";
    description = "Файлы уже на компьютере. Осталось дождаться запуска GigaAM";
  } else if (status.modelStage === "downloading") {
    title = downloadingTitle;
    description = downloadingDescription;
  }

  if (variant === "appshots") {
    return (
      <AppshotsGigaamModelPanel
        title={title}
        description={description}
        progress={progress}
        downloadedBytes={downloadedBytes}
        totalBytes={totalBytes}
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

  return (
    <div className={cn("mx-auto w-full max-w-[500px] space-y-5", className)}>
      <div className="space-y-1 text-center">
        <h2 className="text-xl font-semibold tracking-normal text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="rounded-lg border border-border bg-neutral-50 p-5">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            {isError ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            ) : !isReady ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : null}
            <span className="truncate text-sm font-medium text-foreground">GigaAM</span>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
            {progress}%
          </span>
        </div>

        <Progress value={progress} className="h-2" />

        <div className="mt-3 flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <span>{isReady ? "Готово" : isError ? "Ошибка" : "Подготовка"}</span>
          {totalBytes ? (
            <span className="tabular-nums">
              {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex justify-center">
        {isReady && showReadyAction && onReadyAction ? (
          <Button onClick={onReadyAction} size="xl">
            {readyActionLabel}
          </Button>
        ) : isError || status?.healthStatus === "stopped" ? (
          <Button
            onClick={() => restart()}
            disabled={isRestarting}
            className="h-10 rounded-full px-7"
          >
            {isRestarting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            Повторить
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface AppshotsGigaamModelPanelProps {
  title: string;
  description: string;
  progress: number;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
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
  const detailsText = isError
    ? "Ошибка"
    : "Модель для распознавания речи";
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
              initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -12, filter: "blur(4px)" }}
              transition={{ duration: 0.18, ease: [0.4, 0, 1, 1] }}
            >
              <SectionList>
                <SectionList.Item>
                  <Cell
                    start={<AppshotsGigaamAvatar />}
                    onClick={showAction && !isRestarting ? handleAction : undefined}
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
