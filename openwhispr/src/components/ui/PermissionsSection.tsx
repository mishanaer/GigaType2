import { useTranslation } from "react-i18next";
import { Mic, Shield } from "lucide-react";
import PermissionCard from "./PermissionCard";
import MicPermissionWarning from "./MicPermissionWarning";
import PasteToolsInfo from "./PasteToolsInfo";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import { getCachedPlatform } from "../../utils/platform";

interface PermissionsSectionProps {
  permissions: UsePermissionsReturn;
}

export default function PermissionsSection({ permissions }: PermissionsSectionProps) {
  const { t } = useTranslation();
  const platform = permissions.pasteToolsInfo?.platform;
  const appPlatform = getCachedPlatform();
  const shouldShowAccessibilityPermission =
    appPlatform === "darwin" && !permissions.accessibilityPermissionGranted;

  return (
    <>
      <div className="mx-auto w-full max-w-[500px] space-y-4">
        <PermissionCard
          icon={Mic}
          title={t("onboarding.permissions.microphoneTitle")}
          description={t("onboarding.permissions.microphoneDescription")}
          granted={permissions.micPermissionGranted}
          onRequest={permissions.requestMicPermission}
          buttonText={t("onboarding.permissions.grantAccess")}
        />

        {shouldShowAccessibilityPermission && (
          <PermissionCard
            icon={Shield}
            title={t("onboarding.permissions.accessibilityTitle")}
            description={t("onboarding.permissions.accessibilityDescription")}
            granted={permissions.accessibilityPermissionGranted}
            onRequest={permissions.requestAccessibilityPermission}
            buttonText={t("onboarding.permissions.grantAccess")}
          />
        )}
      </div>

      {!permissions.micPermissionGranted && permissions.micPermissionError && (
        <MicPermissionWarning
          error={permissions.micPermissionError}
          onOpenSoundSettings={permissions.openSoundInputSettings}
          onOpenPrivacySettings={permissions.openMicPrivacySettings}
        />
      )}

      {platform === "linux" &&
        permissions.pasteToolsInfo &&
        !permissions.pasteToolsInfo.available && (
          <PasteToolsInfo
            pasteToolsInfo={permissions.pasteToolsInfo}
            isChecking={permissions.isCheckingPasteTools}
            onCheck={permissions.checkPasteToolsAvailability}
          />
        )}
    </>
  );
}
