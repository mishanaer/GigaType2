/**
 * Utility functions for audio device detection and management.
 * Shared between renderer components and audio manager.
 */

/**
 * Errors where a specific device failed but the system default may still work
 * (stale saved deviceId, unplugged/broken device, device grabbed exclusively).
 */
export const DEVICE_FALLBACK_ERROR_NAMES = new Set([
  "OverconstrainedError",
  "ConstraintNotSatisfiedError",
  "NotFoundError",
  "DevicesNotFoundError",
  "NotReadableError",
  "TrackStartError",
  "AbortError",
]);

/** Extracts the exact audio deviceId from getUserMedia constraints, if any. */
export function getExactAudioDeviceId(constraints: MediaStreamConstraints): string | null {
  const audio = constraints?.audio;
  if (!audio || typeof audio !== "object") return null;
  const deviceId = (audio as MediaTrackConstraints).deviceId;
  if (typeof deviceId === "string") return deviceId;
  if (deviceId && typeof deviceId === "object" && "exact" in deviceId) {
    const exact = (deviceId as ConstrainDOMStringParameters).exact;
    return typeof exact === "string" ? exact : null;
  }
  return null;
}

export type DeviceFallbackResult = {
  /** The opened stream, or null when opts.shouldCancel asked to stop before the retry. */
  stream: MediaStream | null;
  usedFallback: boolean;
  failedDeviceId: string | null;
  /** The configured device's error when the fallback was used. */
  originalError: unknown;
};

/**
 * Opens the microphone, retrying once with the system default device when the
 * configured (exact-deviceId) device fails with a device-specific error.
 * Shared by dictation (audioManager) and meeting capture (meetingRecordingStore)
 * so both recover from stale/broken saved devices with one policy.
 *
 * When the retry also fails, the retry error is rethrown with
 * `originalDeviceErrorName` attached so error UIs can point at the real root
 * cause (e.g. a stale saved device).
 */
export async function getUserMediaWithDefaultDeviceFallback(
  constraints: MediaStreamConstraints,
  fallbackAudioConstraints: MediaTrackConstraints,
  opts: {
    shouldCancel?: () => boolean;
    onFallback?: (info: { failedDeviceId: string; error: unknown }) => void;
    /**
     * Overrides the DEVICE_FALLBACK_ERROR_NAMES policy deciding whether an
     * error from the configured device warrants the default-device retry.
     * The exact-deviceId requirement always applies.
     */
    shouldRetry?: (error: unknown, errorName: string | null) => boolean;
  } = {}
): Promise<DeviceFallbackResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return { stream, usedFallback: false, failedDeviceId: null, originalError: null };
  } catch (error) {
    const failedDeviceId = getExactAudioDeviceId(constraints);
    const errorName = (error as { name?: string } | null)?.name ?? null;
    const retriable = opts.shouldRetry
      ? opts.shouldRetry(error, errorName)
      : errorName !== null && DEVICE_FALLBACK_ERROR_NAMES.has(errorName);
    if (!failedDeviceId || !retriable) {
      throw error;
    }
    if (opts.shouldCancel?.()) {
      return { stream: null, usedFallback: false, failedDeviceId, originalError: error };
    }
    opts.onFallback?.({ failedDeviceId, error });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...fallbackAudioConstraints },
      });
      return { stream, usedFallback: true, failedDeviceId, originalError: error };
    } catch (fallbackError) {
      try {
        (fallbackError as { originalDeviceErrorName?: string | null }).originalDeviceErrorName =
          errorName;
      } catch {
        // DOMException may be frozen in exotic environments — best-effort only
      }
      throw fallbackError;
    }
  }
}

/**
 * Determines if a microphone device is a built-in device based on its label.
 * Works across macOS, Windows, and Linux platforms.
 */
export function isBuiltInMicrophone(label: string): boolean {
  const lowerLabel = label.toLowerCase();

  // Direct built-in indicators
  if (
    lowerLabel.includes("built-in") ||
    lowerLabel.includes("internal") ||
    lowerLabel.includes("macbook") ||
    lowerLabel.includes("integrated")
  ) {
    return true;
  }

  // Generic "microphone" without external device indicators
  if (lowerLabel.includes("microphone")) {
    const externalIndicators = [
      "bluetooth",
      "airpods",
      "wireless",
      "usb",
      "external",
      "headset",
      "webcam",
      "iphone",
      "ipad",
    ];
    return !externalIndicators.some((indicator) => lowerLabel.includes(indicator));
  }

  return false;
}
