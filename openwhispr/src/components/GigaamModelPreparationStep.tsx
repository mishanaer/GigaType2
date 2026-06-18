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
import Spinner from "../vendor/wallet_animations/components/Spinner";
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
      <section className={cn("appshots-permissions-no-drag mx-auto w-[460px] py-[20px]", className)}>
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
                    start={!isReady && !isError ? <Spinner size={24} /> : <Cell.Start type="Icon" />}
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
