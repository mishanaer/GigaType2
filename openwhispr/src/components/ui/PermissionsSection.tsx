import { useTranslation } from "react-i18next";
import { Mic, Shield } from "lucide-react";
import PermissionCard from "./PermissionCard";
import MicPermissionWarning from "./MicPermissionWarning";
import PasteToolsInfo from "./PasteToolsInfo";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import { getCachedPlatform } from "../../utils/platform";
import Cell from "../../vendor/wallet_animations/components/Cells";
import MotionProvider from "../../vendor/wallet_animations/components/MotionProvider";
import SectionList from "../../vendor/wallet_animations/components/SectionList";
import StartView from "../../vendor/wallet_animations/components/StartView";
import AppshotsLogoHeader from "./AppshotsLogoHeader";

type PermissionsSectionVariant = "compact" | "appshots";

interface PermissionItem {
  title: string;
  description?: string;
  granted: boolean;
  onRequest: () => void;
  buttonText: string;
  kind: "accessibility" | "microphone";
}

interface PermissionsSectionProps {
  permissions: UsePermissionsReturn;
  variant?: PermissionsSectionVariant;
}

export default function PermissionsSection({
  permissions,
  variant = "compact",
}: PermissionsSectionProps) {
  const { t } = useTranslation();
  const platform = permissions.pasteToolsInfo?.platform;
  const appPlatform = getCachedPlatform();
  const shouldShowAccessibilityPermission =
    appPlatform === "darwin" && !permissions.accessibilityPermissionGranted;
  const appshotPermissionItems: PermissionItem[] = [
    ...(appPlatform === "darwin"
      ? [
          {
            title: t("onboarding.permissions.accessibilityTitle"),
            granted: permissions.accessibilityPermissionGranted,
            onRequest: permissions.requestAccessibilityPermission,
            buttonText: "Разрешить",
            kind: "accessibility" as const,
          },
        ]
      : []),
    {
      title: t("onboarding.permissions.microphoneTitle"),
      granted: permissions.micPermissionGranted,
      onRequest: permissions.requestMicPermission,
      buttonText: "Разрешить",
      kind: "microphone",
    },
  ];

  return (
    <>
      {variant === "appshots" ? (
        <AppshotsPermissionsPanel
          title="Разрешите доступы"
          description="Тайпу нужен доступ к вставке текста и микрофону, чтобы диктовка работала в любых приложениях"
          permissions={appshotPermissionItems}
        />
      ) : (
        <div className="mx-auto w-full max-w-[500px] space-y-4">
          <PermissionCard
            icon={Mic}
            title={t("onboarding.permissions.microphoneTitle")}
            description={t("onboarding.permissions.microphoneDescription")}
            granted={permissions.micPermissionGranted}
            onRequest={permissions.requestMicPermission}
            buttonText={t("onboarding.permissions.grant")}
          />

          {shouldShowAccessibilityPermission && (
            <PermissionCard
              icon={Shield}
              title={t("onboarding.permissions.accessibilityTitle")}
              description={t("onboarding.permissions.accessibilityDescription")}
              granted={permissions.accessibilityPermissionGranted}
              onRequest={permissions.requestAccessibilityPermission}
              buttonText={t("onboarding.permissions.openSystemSettings")}
            />
          )}
        </div>
      )}

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

interface AppshotsPermissionsPanelProps {
  title: string;
  description: string;
  permissions: PermissionItem[];
}

function AppshotsPermissionsPanel({
  title,
  description,
  permissions,
}: AppshotsPermissionsPanelProps) {
  return (
    <MotionProvider>
      <section className="appshots-permissions-no-drag mx-auto w-[460px] py-[20px]">
        <AppshotsLogoHeader showBuildLabel={false} />
        <StartView title={title} description={description} />

        <SectionList>
          <SectionList.Item>
            {permissions.map((permission) => (
              <AppshotsPermissionRow key={permission.kind} permission={permission} />
            ))}
          </SectionList.Item>
        </SectionList>
      </section>
    </MotionProvider>
  );
}

interface AppshotsPermissionRowProps {
  permission: PermissionItem;
}

function AppshotsPermissionRow({ permission }: AppshotsPermissionRowProps) {
  return (
    <Cell
      start={<Cell.Start type="Icon" />}
      onClick={() => {
        if (!permission.granted) permission.onRequest();
      }}
      end={
        <Cell.Part type="Picker">
          {permission.granted ? "✓" : permission.buttonText}
        </Cell.Part>
      }
    >
      <Cell.Text title={permission.title} description={permission.description} bold />
    </Cell>
  );
}
