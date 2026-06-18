import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AlertDialog } from "./ui/dialog";
import WalletSettingsCells from "./settings/WalletSettingsCells";
import { useDialogs } from "../hooks/useDialogs";
import { useSettings } from "../hooks/useSettings";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";

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
        onHotkeyChange={async (newHotkey) => {
          await registerHotkey(newHotkey);
        }}
        hotkeyDisabled={isHotkeyRegistering}
        validateHotkey={validateDictationHotkey}
        preferBuiltInMic={preferBuiltInMic}
        selectedMicDeviceId={selectedMicDeviceId}
        onPreferBuiltInChange={setPreferBuiltInMic}
        onDeviceSelect={setSelectedMicDeviceId}
      />
    </>
  );
}
