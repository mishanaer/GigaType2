import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { AlertDialog } from "./ui/dialog";
import WalletSettingsCells from "./settings/WalletSettingsCells";
import { useDialogs } from "../hooks/useDialogs";
import { useSettings } from "../hooks/useSettings";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { trackTelemetryEvent } from "../utils/telemetry";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const {
    dictationKey,
    setDictationKey,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    hideCapsule,
    setHideCapsule,
  } = useSettings();

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const validateDictationHotkey = useCallback(
    (hotkey: string) => validateHotkeyForSlot(hotkey, {}, t),
    [t]
  );

  useEffect(() => {
    void trackTelemetryEvent("settings_screen_viewed", {}, {
      onceKey: "settings_screen_viewed_sent",
    });
  }, []);

  return (
    <>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <WalletSettingsCells
        dictationKey={dictationKey}
        onHotkeyChange={registerHotkey}
        hotkeyDisabled={isHotkeyRegistering}
        validateHotkey={validateDictationHotkey}
        preferBuiltInMic={preferBuiltInMic}
        selectedMicDeviceId={selectedMicDeviceId}
        onPreferBuiltInChange={setPreferBuiltInMic}
        onDeviceSelect={setSelectedMicDeviceId}
        hideCapsule={hideCapsule}
        onHideCapsuleChange={setHideCapsule}
      />
    </>
  );
}
