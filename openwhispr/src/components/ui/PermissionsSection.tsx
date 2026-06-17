import { useTranslation } from "react-i18next";
import { Mic, Shield } from "lucide-react";
import PermissionCard from "./PermissionCard";
import MicPermissionWarning from "./MicPermissionWarning";
import PasteToolsInfo from "./PasteToolsInfo";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import { getCachedPlatform } from "../../utils/platform";

type PermissionsSectionVariant = "compact" | "appshots";

interface PermissionItem {
  title: string;
  description: string;
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
            description: "Вставляет текст в приложения",
            granted: permissions.accessibilityPermissionGranted,
            onRequest: permissions.requestAccessibilityPermission,
            buttonText: "Allow",
            kind: "accessibility" as const,
          },
        ]
      : []),
    {
      title: t("onboarding.permissions.microphoneTitle"),
      description: "Записывает голос для транскрипции",
      granted: permissions.micPermissionGranted,
      onRequest: permissions.requestMicPermission,
      buttonText: "Allow",
      kind: "microphone",
    },
  ];

  return (
    <>
      {variant === "appshots" ? (
        <AppshotsPermissionsPanel
          title="Enable GigaType"
          description={t("permissionsGate.description")}
          permissions={appshotPermissionItems}
          doneText="Done"
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
  doneText: string;
}

function AppshotsPermissionsPanel({
  title,
  description,
  permissions,
  doneText,
}: AppshotsPermissionsPanelProps) {
  return (
    <section className="relative mx-auto h-[442px] w-[600px] shrink-0 overflow-hidden text-[#050505]">
      <AppshotsHeaderIcon />

      <div
        role="heading"
        aria-level={1}
        className="absolute left-0 top-[116px] h-[38px] w-full text-center text-[32px] font-[800] leading-[38px] text-black"
      >
        {title}
      </div>
      <p className="absolute left-[46px] top-[164px] h-[42px] w-[508px] text-center text-[17px] font-[500] leading-[21px] text-[#515358]">
        {description}
      </p>

      {permissions.map((permission, index) => (
        <AppshotsPermissionRow
          key={permission.kind}
          permission={permission}
          doneText={doneText}
          rowIndex={index}
        />
      ))}
    </section>
  );
}

function AppshotsHeaderIcon() {
  return (
    <div
      className="absolute left-[268px] top-[36px] h-[64px] w-[64px] rounded-[15px] border border-[#d8dbe3] bg-white"
      aria-hidden="true"
    />
  );
}

interface AppshotsPermissionRowProps {
  permission: PermissionItem;
  doneText: string;
  rowIndex: number;
}

function AppshotsPermissionRow({ permission, doneText, rowIndex }: AppshotsPermissionRowProps) {
  const rowTop = rowIndex === 0 ? 220 : 318;

  return (
    <div
      className="absolute left-[41px] h-[80px] w-[518px] rounded-[25px] bg-white"
      style={{ top: rowTop }}
    >
      <AppshotsPermissionIcon />

      <div
        role="heading"
        aria-level={2}
        className="absolute left-[84px] top-[20px] h-[21px] max-w-[340px] truncate text-[17px] font-[800] leading-[21px] text-[#202333]"
      >
        {permission.title}
      </div>
      <p className="absolute left-[84px] top-[43px] max-w-[340px] truncate text-[17px] font-[500] leading-[20px] text-[#5b5d69]">
        {permission.description}
      </p>

      {permission.granted ? (
        <span className="absolute right-[19px] top-[28px] inline-flex h-[24px] min-w-[56px] items-center justify-center gap-[5px] text-[14px] font-[700] leading-[24px] text-[#42444b]">
          {doneText}
          <span className="text-[15px] leading-none">✓</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={permission.onRequest}
          className="appshots-permissions-no-drag absolute right-[19px] top-[28px] h-[24px] min-w-[56px] rounded-[12px] bg-[#0a84ff] px-[12px] text-[14px] font-[700] leading-[24px] text-white shadow-none transition-colors duration-150 hover:bg-[#007aff] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#0a84ff]/30"
        >
          {permission.buttonText}
        </button>
      )}
    </div>
  );
}

function AppshotsPermissionIcon() {
  return (
    <div
      className="absolute left-[18px] top-[18px] h-[44px] w-[44px] rounded-[10px] border border-[#d8dbe3] bg-white"
      aria-hidden="true"
    />
  );
}
