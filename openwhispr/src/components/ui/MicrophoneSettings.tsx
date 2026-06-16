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
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
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

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <label className="text-base font-normal leading-5 text-foreground">
          {t("microphoneSettings.inputDevice")}
        </label>
      </div>
      <div className="w-full shrink-0 sm:w-[282px]">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <Select value={activeDeviceId} onValueChange={handleDeviceSelect}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("microphoneSettings.selectPlaceholder")}>
                {activeDeviceLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t("microphoneSettings.systemDefault")}</SelectItem>
              {selectDevices.map((device) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label}
                  {device.isBuiltIn && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("microphoneSettings.builtIn")}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
};

export default MicrophoneSettings;
