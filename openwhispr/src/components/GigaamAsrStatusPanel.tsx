import { AlertTriangle, FolderOpen, Loader2, Power, RotateCw } from "lucide-react";
import { useGigaamSidecarStatus } from "../hooks/useGigaamSidecarStatus";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

interface GigaamAsrStatusPanelProps {
  className?: string;
}

export default function GigaamAsrStatusPanel({ className }: GigaamAsrStatusPanelProps) {
  const { status, restart, isRestarting } = useGigaamSidecarStatus();

  if (!status?.available || status.healthStatus === "ok") return null;

  if (status.healthStatus === "error") {
    return (
      <Alert variant="destructive" className={cn("rounded-lg", className)}>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>GigaAM failed to load.</AlertTitle>
        <AlertDescription>
          {status.healthDetail && (
            <p className="mb-2 break-words text-xs opacity-90">{status.healthDetail}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => window.electronAPI?.openLogsFolder?.()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open logs
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => restart()}
              disabled={isRestarting}
            >
              {isRestarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              Retry
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7"
              onClick={() => window.electronAPI?.appQuit?.()}
            >
              <Power className="h-3.5 w-3.5" />
              Quit
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className={cn("rounded-lg", className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <AlertTitle>Preparing local ASR model...</AlertTitle>
      <AlertDescription>
        Downloading/preparing GigaAM may take several minutes on first launch.
      </AlertDescription>
    </Alert>
  );
}
