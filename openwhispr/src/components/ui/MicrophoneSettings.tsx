import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";

interface AudioDevice {
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface MicrophoneSettingsProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string) => void;
  variant?: "default" | "appshots";
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
  variant = "default",
}) => {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setError(null);

    try {
      // Request permission first to get device labels
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(d.label),
        }));

      setDevices(audioInputs);
    } catch {
      setError(t("microphoneSettings.errors.unableToAccess"));
    }
  }, [t]);

  useEffect(() => {
    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices]);

  const builtInDevice = devices.find((d) => d.isBuiltIn);
  const selectDevices = devices.filter((device) => device.deviceId !== "default");
  const activeDeviceId = preferBuiltInMic
    ? builtInDevice?.deviceId || "default"
    : selectedMicDeviceId || "default";
  const activeDevice = devices.find((d) => d.deviceId === activeDeviceId);
  const activeDeviceLabel =
    activeDeviceId === "default"
      ? t("microphoneSettings.systemDefault")
      : activeDevice?.label || t("microphoneSettings.unknownDevice");

  const handleDeviceSelect = (deviceId: string) => {
    onPreferBuiltInChange(false);
    onDeviceSelect(deviceId === "default" ? "" : deviceId);
  };
  const isAppshots = variant === "appshots";
  const appshotsItemClassName = "text-[17px] font-[400] leading-[21px]";

  return (
    <div className={isAppshots ? "w-full" : "w-full sm:w-[282px]"}>
      {error ? (
        <p
          className={
            isAppshots
              ? "truncate text-[14px] font-[500] leading-[16px] text-muted-foreground"
              : "text-sm text-destructive"
          }
        >
          {error}
        </p>
      ) : (
        <Select value={activeDeviceId} onValueChange={handleDeviceSelect}>
          <SelectTrigger
            className={
              isAppshots
                ? "appshots-settings-select h-[64px] min-h-[64px] w-full rounded-[25px] border-0 bg-card px-[30px] text-[17px] font-[400] leading-[21px] text-foreground shadow-none outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/25"
                : "w-full"
            }
          >
            <SelectValue placeholder={t("microphoneSettings.selectPlaceholder")}>
              {activeDeviceLabel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            position={isAppshots ? "popper" : undefined}
            align={isAppshots ? "start" : undefined}
            className={
              isAppshots
                ? "appshots-settings-no-drag appshots-settings-select-content w-[var(--radix-select-trigger-width)] rounded-[18px] border-0 bg-popover text-[17px] font-[400] text-popover-foreground shadow-none"
                : undefined
            }
          >
            <SelectItem
              className={isAppshots ? `appshots-settings-no-drag ${appshotsItemClassName}` : undefined}
              value="default"
            >
              {t("microphoneSettings.systemDefault")}
            </SelectItem>
            {selectDevices.map((device) => (
              <SelectItem
                key={device.deviceId}
                className={isAppshots ? `appshots-settings-no-drag ${appshotsItemClassName}` : undefined}
                value={device.deviceId}
              >
                {device.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
};

export default MicrophoneSettings;
