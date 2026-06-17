import { AlertTriangle, Loader2, RotateCw } from "lucide-react";

import type { GigaamSidecarStatus } from "../types/electron";
import { isGigaamModelReady } from "../utils/gigaamModelStatus";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { cn } from "./lib/utils";

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

  let title = "Проверяем модель";
  let description = "GigaType готовит локальную GigaAM для распознавания речи.";

  if (!status) {
    title = "Проверяем модель";
    description = "Получаем статус локальной GigaAM.";
  } else if (!status.available) {
    title = "GigaAM недоступна";
    description = "Локальная модель доступна только в macOS сборке для Apple Silicon.";
  } else if (isError) {
    title = "Не удалось подготовить модель";
    description = status.healthDetail || "Проверьте подключение к интернету и попробуйте ещё раз.";
  } else if (isReady) {
    title = "Модель готова";
    description = "GigaAM загружена и готова к диктовке.";
  } else if (status.modelStage === "loading" || status.modelCacheComplete) {
    title = "Загружаем модель в память";
    description = "Файлы уже на компьютере. Осталось дождаться запуска GigaAM.";
  } else if (status.modelStage === "downloading") {
    title = "Загружаем модель";
    description = "Первый запуск может занять несколько минут.";
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
            <span className="truncate text-sm font-medium text-foreground">GigaAM e2e RNNT</span>
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
  downloadedBytes,
  totalBytes,
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
  const statusText = isReady ? "Готово" : isError ? "Ошибка" : "Подготовка";

  return (
    <section
      className={cn(
        "relative mx-auto h-[442px] w-[600px] shrink-0 overflow-hidden text-[#050505]",
        className
      )}
    >
      <div
        className="absolute left-[268px] top-[36px] h-[64px] w-[64px] rounded-[15px] border border-[#d8dbe3] bg-white"
        aria-hidden="true"
      />

      <div
        role="heading"
        aria-level={1}
        className="absolute left-0 top-[116px] h-[38px] w-full text-center text-[32px] font-[800] leading-[38px] text-black"
      >
        {title}
      </div>
      <p className="absolute left-[46px] top-[164px] h-[42px] w-[508px] text-center text-[17px] font-[500] leading-[21px] text-[#515358]">
        {description}
      </p>

      <div className="absolute left-[41px] top-[220px] h-[112px] w-[518px] rounded-[25px] bg-white">
        <div
          className="absolute left-[18px] top-[18px] flex h-[44px] w-[44px] items-center justify-center rounded-[10px] border border-[#d8dbe3] bg-white"
          aria-hidden="true"
        >
          {isError ? (
            <AlertTriangle className="h-[20px] w-[20px] text-[#5b5d69]" strokeWidth={2.4} />
          ) : !isReady ? (
            <Loader2 className="h-[20px] w-[20px] animate-spin text-[#5b5d69]" strokeWidth={2.4} />
          ) : null}
        </div>

        <div
          role="heading"
          aria-level={2}
          className="absolute left-[84px] top-[20px] h-[21px] max-w-[320px] truncate text-[17px] font-[800] leading-[21px] text-[#202333]"
        >
          GigaAM e2e RNNT
        </div>
        <span className="absolute right-[19px] top-[20px] h-[21px] text-[17px] font-[800] leading-[21px] tabular-nums text-[#5b5d69]">
          {progress}%
        </span>

        <div className="absolute left-[84px] right-[19px] top-[55px] h-[8px] overflow-hidden rounded-full bg-[#b4b7c1]">
          <div
            className="h-full rounded-full bg-[#202333] transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="absolute left-[84px] top-[75px] h-[21px] text-[17px] font-[500] leading-[21px] text-[#5b5d69]">
          {statusText}
        </div>
        {totalBytes ? (
          <div className="absolute right-[19px] top-[75px] h-[21px] text-[17px] font-[500] leading-[21px] tabular-nums text-[#5b5d69]">
            {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
          </div>
        ) : null}
      </div>

      {showAction ? (
        <button
          type="button"
          onClick={() => {
            if (isReady) {
              void onReadyAction?.();
            } else {
              void onRetry();
            }
          }}
          disabled={isRestarting}
          className="appshots-permissions-no-drag absolute left-1/2 top-[356px] inline-flex h-[40px] min-w-[118px] -translate-x-1/2 items-center justify-center gap-[8px] rounded-[20px] bg-[#0a84ff] px-[18px] text-[16px] font-[800] leading-[20px] text-white transition-colors duration-150 hover:bg-[#007aff] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#0a84ff]/30"
        >
          {isRestarting ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.5} />
          ) : !isReady ? (
            <RotateCw className="h-[18px] w-[18px]" strokeWidth={2.5} />
          ) : null}
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
