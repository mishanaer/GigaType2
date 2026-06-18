import React, { useCallback, useEffect, useMemo, useState } from "react";
import Cell from "../../vendor/wallet_animations/components/Cells";
import MotionProvider from "../../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../../vendor/wallet_animations/components/SectionList";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { HotkeyInput } from "../ui/HotkeyInput";
import { CopyButton } from "../ui/SpellCopyButton";

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
  logPathOverride?: string;
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
  logPathOverride,
}: WalletSettingsCellsProps) {
  const [captureKey, setCaptureKey] = useState(0);
  const [isHotkeyArmed, setIsHotkeyArmed] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [logPath, setLogPath] = useState("");
  const copyLogButtonRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const hadApple = document.body.classList.contains("apple");
    const hadMaterial = document.body.classList.contains("material");

    document.body.classList.remove("material");
    document.body.classList.add("apple");

    return () => {
      if (!hadApple) {
        document.body.classList.remove("apple");
      }
      if (hadMaterial) {
        document.body.classList.add("material");
      }
    };
  }, []);

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

  useEffect(() => {
    if (logPathOverride !== undefined) {
      setLogPath(logPathOverride);
      return undefined;
    }

    let cancelled = false;

    window.electronAPI
      ?.getDebugState?.()
      .then((state) => {
        if (!cancelled) {
          setLogPath(state.logPath ?? "");
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [logPathOverride]);

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

  const endHotkeyCapture = useCallback(() => {
    setIsHotkeyArmed(false);
  }, []);

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

  const handleCopyLogsCellClick = useCallback(() => {
    copyLogButtonRef.current?.click();
  }, []);

  return (
    <MotionProvider>
      <div className="appshots-settings-no-drag">
        <SectionList>
          <SectionList.Item>
            <Cell
              onPointerEnter={beginHotkeyCapture}
              onPointerLeave={endHotkeyCapture}
              onClick={beginHotkeyCapture}
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
                <div className="wallet-settings-native-select-wrap appshots-settings-no-drag">
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

            <Cell
              onClick={handleCopyLogsCellClick}
              end={
                <CopyButton
                  ref={copyLogButtonRef}
                  value={logPath}
                  onClick={(event) => event.stopPropagation()}
                  className="appshots-settings-no-drag"
                />
              }
            >
              <Cell.Text title="Скопировать логи" description="Чтобы отправить разрабам" />
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
