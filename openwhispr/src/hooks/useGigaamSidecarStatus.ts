import { useCallback, useEffect, useState } from "react";
import type { GigaamSidecarStatus } from "../types/electron";
import logger from "../utils/logger";

export function useGigaamSidecarStatus() {
  const [status, setStatus] = useState<GigaamSidecarStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI?.getGigaamSidecarStatus?.();
      if (next) setStatus(next);
      return next ?? null;
    } catch (err) {
      logger.warn(
        "Failed to fetch GigaAM sidecar status",
        { error: (err as Error).message },
        "settings"
      );
      return null;
    }
  }, []);

  const restart = useCallback(async () => {
    setIsRestarting(true);
    try {
      const next = await window.electronAPI?.restartGigaamSidecar?.();
      if (next) setStatus(next);
      return next ?? null;
    } catch (err) {
      logger.warn(
        "Failed to restart GigaAM sidecar",
        { error: (err as Error).message },
        "settings"
      );
      return null;
    } finally {
      setIsRestarting(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    refresh().then((next) => {
      if (mounted && next) setStatus(next);
    });
    const unsubscribe = window.electronAPI?.onGigaamSidecarStatus?.((next) => {
      if (mounted) setStatus(next);
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [refresh]);

  return { status, refresh, restart, isRestarting };
}
