import type { GigaamSidecarStatus } from "../types/electron";

export function isGigaamModelReady(status?: GigaamSidecarStatus | null) {
  return status?.healthStatus === "ok" || status?.modelStage === "ready";
}

export function shouldShowGigaamModelPreparation(status?: GigaamSidecarStatus | null) {
  return Boolean(status?.available && !isGigaamModelReady(status));
}
