import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import Cell from "../../vendor/wallet_animations/components/Cells";
import CellStack from "../../vendor/wallet_animations/components/CellStack";
import MotionProvider from "../../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../../vendor/wallet_animations/components/SectionList";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { getCachedPlatform } from "../../utils/platform";
import { HotkeyInput } from "../ui/HotkeyInput";

interface AudioDevice {
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface WalletSettingsCellsProps {
  dictationKey: string;
  onHotkeyChange: (hotkey: string) => Promise<boolean | void> | boolean | void;
  onFnConflictWarning?: () => void;
  hotkeyDisabled?: boolean;
  validateHotkey?: (hotkey: string) => string | null | undefined;
  activationMode: "tap" | "push";
  onActivationModeChange: (mode: "tap" | "push") => void;
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string) => void;
  hideCapsule: boolean;
  onHideCapsuleChange: (value: boolean) => void;
  showDockIcon?: boolean;
  onShowDockIconChange?: (value: boolean) => void;
  audioCuesEnabled: boolean;
  onAudioCuesEnabledChange: (value: boolean) => void;
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
  onFnConflictWarning,
  hotkeyDisabled = false,
  validateHotkey,
  activationMode,
  onActivationModeChange,
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
  hideCapsule,
  onHideCapsuleChange,
  showDockIcon = true,
  onShowDockIconChange,
  audioCuesEnabled,
  onAudioCuesEnabledChange,
  devicesOverride,
}: WalletSettingsCellsProps) {
  const [captureKey, setCaptureKey] = useState(0);
  const [invalidHotkeyShakeKey, setInvalidHotkeyShakeKey] = useState(0);
  const [isHotkeyArmed, setIsHotkeyArmed] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const invalidHotkeyReleaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInvalidHotkeyShakingRef = useRef(false);

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
  const activeMicrophoneLabel =
    microphoneOptions.find((device) => device.deviceId === activeDeviceId)?.label ?? "Системный";
  const platform = getCachedPlatform();
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";
  const isWindowsOrLinux = !isMac;

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

  const handleHotkeyInvalid = useCallback(() => {
    if (invalidHotkeyReleaseRef.current) {
      clearTimeout(invalidHotkeyReleaseRef.current);
    }

    isInvalidHotkeyShakingRef.current = true;
    setInvalidHotkeyShakeKey((value) => value + 1);
    invalidHotkeyReleaseRef.current = setTimeout(() => {
      isInvalidHotkeyShakingRef.current = false;
      invalidHotkeyReleaseRef.current = null;
      setIsHotkeyArmed(false);
    }, 220);
  }, []);

  const handleHotkeyChange = useCallback(
    async (newHotkey: string) => {
      // Globe/Fn is the default macOS dictation key. The old "Fn используется
      // macOS" warning fired on every setup and was pure noise (the hotkey saves
      // and works regardless), so it was removed per team feedback.
      void onFnConflictWarning;
      const registered = await onHotkeyChange(newHotkey);
      if (registered === false) {
        handleHotkeyInvalid();
        return;
      }
      setIsHotkeyArmed(false);
    },
    [handleHotkeyInvalid, onHotkeyChange]
  );

  const handleHotkeyBlur = useCallback(() => {
    if (!isInvalidHotkeyShakingRef.current) {
      setIsHotkeyArmed(false);
    }
  }, []);

  const handleMicrophoneChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const deviceId = event.target.value;
      onPreferBuiltInChange(false);
      onDeviceSelect(deviceId === "default" ? "" : deviceId);
    },
    [onDeviceSelect, onPreferBuiltInChange]
  );

  const handleActivationModeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onActivationModeChange(event.target.value === "tap" ? "tap" : "push");
    },
    [onActivationModeChange]
  );

  useEffect(() => {
    return () => {
      if (invalidHotkeyReleaseRef.current) {
        clearTimeout(invalidHotkeyReleaseRef.current);
      }
    };
  }, []);

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
                <div
                  key={invalidHotkeyShakeKey}
                  className={
                    invalidHotkeyShakeKey > 0
                      ? "wallet-settings-hotkey-shell wallet-settings-hotkey-shell--invalid"
                      : "wallet-settings-hotkey-shell"
                  }
                >
                  <Cell.Part type="Picker">
                    {isHotkeyArmed
                      ? isWindows
                        ? "Нажмите клавиши · Fn недоступна"
                        : "Нажмите клавиши"
                      : getHotkeyLabel(dictationKey)}
                  </Cell.Part>
                </div>
              }
            >
              <Cell.Text title="Хоткей" />
            </Cell>

            <Cell
              end={
                <div className="wallet-settings-native-select-wrap appshots-window-no-drag appshots-settings-no-drag">
                  <Cell.Part type="Dropdown">
                    {activationMode === "push" ? "Удерживать хоткей" : "Старт-стоп"}
                  </Cell.Part>
                  <select
                    className="wallet-settings-native-select appshots-settings-no-drag"
                    aria-label="Способ диктовки"
                    value={activationMode}
                    onChange={handleActivationModeChange}
                  >
                    <option value="push">Удерживать хоткей</option>
                    <option value="tap">Старт-стоп</option>
                  </select>
                </div>
              }
            >
              <Cell.Text title="Способ диктовки" />
            </Cell>

            <Cell
              end={
                <div className="wallet-settings-native-select-wrap appshots-window-no-drag appshots-settings-no-drag">
                  <Cell.Part type="Dropdown">
                    {isWindowsOrLinux ? (
                      <span
                        className="wallet-settings-native-select-label"
                        title={activeMicrophoneLabel}
                      >
                        {activeMicrophoneLabel}
                      </span>
                    ) : (
                      activeMicrophoneLabel
                    )}
                  </Cell.Part>
                  <select
                    className="wallet-settings-native-select appshots-settings-no-drag"
                    aria-label="Микрофон"
                    title={isWindowsOrLinux ? activeMicrophoneLabel : undefined}
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

          <CellStack ariaLabel="Внешний вид и звуки">
            <CellStack.Morph rotateEndOnExpand>
              <Cell
                end={
                  <Cell.Text
                    title={
                      <ChevronDownIcon
                        className="block size-5 text-[var(--tg-theme-subtitle-text-color)] opacity-70"
                        aria-hidden
                      />
                    }
                  />
                }
              >
                <Cell.Text title="Внешний вид и звуки" />
              </Cell>
              <Cell>
                <Cell.Text title="Внешний вид и звуки" />
              </Cell>
            </CellStack.Morph>

            <Cell.Switch
              value={!hideCapsule}
              onChange={(showCapsule) => onHideCapsuleChange(!showCapsule)}
              ariaLabel="Показывать капсулу"
            >
              <Cell.Text title="Показывать капсулу" />
            </Cell.Switch>

            {isMac && onShowDockIconChange && (
              <Cell.Switch
                value={showDockIcon}
                onChange={onShowDockIconChange}
                ariaLabel="Показывать иконку в Dock"
              >
                <Cell.Text title="Показывать иконку в Dock" />
              </Cell.Switch>
            )}

            <Cell.Switch
              value={audioCuesEnabled}
              onChange={onAudioCuesEnabledChange}
              ariaLabel="Звуки диктовки"
            >
              <Cell.Text title="Звуки диктовки" />
            </Cell.Switch>
          </CellStack>
        </SectionList>

        <div className="wallet-settings-hidden-hotkey" aria-hidden="true">
          {isHotkeyArmed && captureKey > 0 && (
            <HotkeyInput
              key={captureKey}
              value={dictationKey}
              onChange={handleHotkeyChange}
              onInvalid={handleHotkeyInvalid}
              // Blur without a captured key (the Win key opened the Start
              // menu, a click landed elsewhere, …) ends the capture inside
              // HotkeyInput — handleHotkeyBlur disarms the cell so it doesn't
              // stay stuck on "press keys" with clicks early-returning.
              onBlur={handleHotkeyBlur}
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
