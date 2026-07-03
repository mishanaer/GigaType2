import React, { useCallback, useEffect, useMemo, useState } from "react";
import Cell from "../../vendor/wallet_animations/components/Cells";
import MotionProvider from "../../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../../vendor/wallet_animations/components/SectionList";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { HotkeyInput } from "../ui/HotkeyInput";

interface AudioDevice {
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface WalletSettingsCellsProps {
  dictationKey: string;
  onHotkeyChange: (hotkey: string) => Promise<void> | void;
  hotkeyDisabled?: boolean;
  validateHotkey?: (hotkey: string) => string | null | undefined;
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string) => void;
  devicesOverride?: AudioDevice[];
}

const getHotkeyLabel = (hotkey: string) => {
  if (isGlobeLikeHotkey(hotkey)) {
    return "Fn";
  }

  const label = formatHotkeyLabel(hotkey);
  return label === "Globe/Fn" ? "Fn" : label;
};

export default function WalletSettingsCells({
  dictationKey,
  onHotkeyChange,
  hotkeyDisabled = false,
  validateHotkey,
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
  devicesOverride,
}: WalletSettingsCellsProps) {
  const [captureKey, setCaptureKey] = useState(0);
  const [isHotkeyArmed, setIsHotkeyArmed] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);

  const loadDevices = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(device.label),
        }));

      setDevices(audioInputs);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    if (devicesOverride) {
      setDevices(devicesOverride);
      return undefined;
    }

    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, [devicesOverride, loadDevices]);

  const builtInDevice = devices.find((device) => device.isBuiltIn);
  const selectDevices = devices.filter((device) => device.deviceId !== "default");
  const activeDeviceId = preferBuiltInMic
    ? builtInDevice?.deviceId || "default"
    : selectedMicDeviceId || "default";
  const microphoneOptions = useMemo(
    () => [{ deviceId: "default", label: "Системный" }, ...selectDevices],
    [selectDevices]
  );

  const beginHotkeyCapture = useCallback(() => {
    if (hotkeyDisabled || isHotkeyArmed) {
      return;
    }

    setIsHotkeyArmed(true);
    setCaptureKey((value) => value + 1);
  }, [hotkeyDisabled, isHotkeyArmed]);

  const handleHotkeyKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      beginHotkeyCapture();
    },
    [beginHotkeyCapture]
  );

  const handleHotkeyChange = useCallback(
    async (newHotkey: string) => {
      await onHotkeyChange(newHotkey);
      setIsHotkeyArmed(false);
    },
    [onHotkeyChange]
  );

  const handleMicrophoneChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const deviceId = event.target.value;
      onPreferBuiltInChange(false);
      onDeviceSelect(deviceId === "default" ? "" : deviceId);
    },
    [onDeviceSelect, onPreferBuiltInChange]
  );

  return (
    <MotionProvider>
      <div className="appshots-settings-no-drag">
        <SectionList>
          <SectionList.Item>
            <Cell
              onClick={beginHotkeyCapture}
              onKeyDown={handleHotkeyKeyDown}
              role={hotkeyDisabled ? undefined : "button"}
              tabIndex={hotkeyDisabled ? undefined : 0}
              aria-disabled={hotkeyDisabled}
              end={
                <Cell.Part type="Picker">
                  {isHotkeyArmed ? "Нажмите клавиши" : getHotkeyLabel(dictationKey)}
                </Cell.Part>
              }
            >
              <Cell.Text title="Хоткей" />
            </Cell>

            <Cell
              end={
                <div className="wallet-settings-native-select-wrap appshots-window-no-drag appshots-settings-no-drag">
                  <Cell.Part type="Dropdown">
                    {microphoneOptions.find((device) => device.deviceId === activeDeviceId)?.label ??
                      "Системный"}
                  </Cell.Part>
                  <select
                    className="wallet-settings-native-select appshots-settings-no-drag"
                    aria-label="Микрофон"
                    value={activeDeviceId}
                    onChange={handleMicrophoneChange}
                  >
                    {microphoneOptions.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </div>
              }
            >
              <Cell.Text title="Микрофон" />
            </Cell>

          </SectionList.Item>
        </SectionList>

        <div className="wallet-settings-hidden-hotkey" aria-hidden="true">
          {isHotkeyArmed && captureKey > 0 && (
            <HotkeyInput
              key={captureKey}
              value={dictationKey}
              onChange={handleHotkeyChange}
              disabled={hotkeyDisabled}
              autoFocus
              validate={validateHotkey}
              variant="appshotsSettings"
            />
          )}
        </div>
      </div>
    </MotionProvider>
  );
}
