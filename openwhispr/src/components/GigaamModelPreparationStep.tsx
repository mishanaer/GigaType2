import { AlertTriangle, Loader2, RotateCw } from "lucide-react";

import type { GigaamSidecarStatus } from "../types/electron";
import { isGigaamModelReady } from "../utils/gigaamModelStatus";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { cn } from "./lib/utils";

interface GigaamModelPreparationStepProps {
  status: GigaamSidecarStatus | null;
  restart: () => void | Promise<unknown>;
  isRestarting?: boolean;
  showReadyAction?: boolean;
  readyActionLabel?: string;
  onReadyAction?: () => void | Promise<void>;
  className?: string;
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
