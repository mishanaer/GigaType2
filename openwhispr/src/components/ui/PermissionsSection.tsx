import { useTranslation } from "react-i18next";
import { Mic, Shield } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import PermissionCard from "./PermissionCard";
import MicPermissionWarning from "./MicPermissionWarning";
import PasteToolsInfo from "./PasteToolsInfo";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import { getCachedPlatform } from "../../utils/platform";
import { RegularButton } from "../../vendor/wallet_animations/components/Button";
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
  avatarUserId: number;
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
    {
      title: t("onboarding.permissions.microphoneTitle"),
      granted: permissions.micPermissionGranted,
      onRequest: permissions.requestMicPermission,
      buttonText: "Разрешить",
      kind: "microphone",
      avatarUserId: 3,
    },
    ...(appPlatform === "darwin"
      ? [
          {
            title: t("onboarding.permissions.accessibilityTitle"),
            granted: permissions.accessibilityPermissionGranted,
            onRequest: permissions.requestAccessibilityPermission,
            buttonText: "Разрешить",
            kind: "accessibility" as const,
            avatarUserId: 5,
          },
        ]
      : []),
  ];

  return (
    <>
      {variant === "appshots" ? (
        <AppshotsPermissionsPanel
          title="Разрешите доступы"
          description="Гигатайпу нужен доступ к вставке текста и микрофону, чтобы диктовка работала в любых приложениях"
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

        <SectionList style={{ gap: 0, padding: 0, paddingBottom: 0 }}>
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
  const requestPermission = () => {
    if (!permission.granted) {
      permission.onRequest();
    }
  };
  const handlePermissionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (permission.granted || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    requestPermission();
  };
  const handlePermissionButtonClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    requestPermission();
  };
  const handlePermissionButtonKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    handlePermissionKeyDown(event);
  };

  return (
    <Cell
      start={<AppshotsPermissionAvatar kind={permission.kind} userId={permission.avatarUserId} />}
      onClick={permission.granted ? undefined : requestPermission}
      end={
        permission.granted ? (
          <Cell.Part type="Picker">✓</Cell.Part>
        ) : (
          <RegularButton
            variant="filled"
            label={permission.buttonText}
            onClick={handlePermissionButtonClick}
            onKeyDown={handlePermissionButtonKeyDown}
            role="button"
            tabIndex={0}
            style={{ padding: "7px 10px", borderRadius: 18 }}
          />
        )
      }
    >
      <Cell.Text title={permission.title} description={permission.description} bold />
    </Cell>
  );
}

const permissionAvatarColors = [
  ["#e17076", "#ff885e", "#ff516a"],
  ["#faa774", "#ffcd6a", "#ffa85c"],
  ["#a695e7", "#82b1ff", "#665fff"],
  ["#7bc862", "#a0de7e", "#54cb68"],
  ["#6ec9cb", "#53edd6", "#28c9b7"],
  ["#65aadd", "#72d5fd", "#2a9ef1"],
  ["#ee7aae", "#e0a2f3", "#d669ed"],
] as const;

interface AppshotsPermissionAvatarProps {
  kind: PermissionItem["kind"];
  userId: number;
  size?: number;
}

function AppshotsPermissionAvatar({ kind, userId, size = 40 }: AppshotsPermissionAvatarProps) {
  const [, gradientStart, gradientEnd] =
    permissionAvatarColors[userId % permissionAvatarColors.length];
  const style: CSSProperties = {
    width: size,
    height: size,
    background: `linear-gradient(180deg, ${gradientStart} 0%, ${gradientEnd} 100%)`,
  };
  const Icon = kind === "microphone" ? MicAvatarIcon : TextEnterAvatarIcon;

  return (
    <div
      className="appshots-permission-avatar"
      style={style}
      aria-hidden="true"
    >
      <Icon />
    </div>
  );
}

function MicAvatarIcon() {
  return (
    <svg width="24" height="25" viewBox="0 0 24 25" fill="none" aria-hidden="true">
      <rect x="8" y="2" width="8" height="13" rx="4" fill="currentColor" />
      <path
        d="M18.7055 13C18.3763 14.1041 17.7765 15.1203 16.947 15.9497C15.6343 17.2625 13.8538 18 11.9973 18C10.1408 18 8.36029 17.2625 7.04753 15.9497C6.21808 15.1203 5.61828 14.1041 5.28906 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 18V21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TextEnterAvatarIcon() {
  return (
    <svg width="24" height="25" viewBox="0 0 24 25" fill="none" aria-hidden="true">
      <path
        d="M19 20.1445C19.5523 20.1445 20 20.5961 20 21.1523C19.9998 21.7084 19.5521 22.1592 19 22.1592H5C4.44786 22.1592 4.00023 21.7084 4 21.1523C4 20.5961 4.44772 20.1445 5 20.1445H19ZM16.5791 3.02148C18.0851 3.02148 18.8049 3.1426 19.5361 3.53223C20.1592 3.8643 20.654 4.35672 20.9873 4.97754C21.3784 5.70632 21.5 6.42391 21.5 7.9248V13.2266C21.5 14.7275 21.3784 15.445 20.9873 16.1738C20.654 16.7948 20.1593 17.288 19.5361 17.6201C18.805 18.0097 18.085 18.1299 16.5791 18.1299H7.4209C5.91503 18.1299 5.19504 18.0097 4.46387 17.6201C3.84069 17.288 3.34603 16.7948 3.0127 16.1738C2.62156 15.445 2.5 14.7275 2.5 13.2266V7.9248C2.50001 6.42391 2.62157 5.70632 3.0127 4.97754C3.34601 4.35672 3.84081 3.8643 4.46387 3.53223C5.19511 3.1426 5.9149 3.02148 7.4209 3.02148H16.5791ZM15.1924 7.1084C14.819 6.87256 14.325 6.98427 14.0889 7.35742L13.6113 8.11328L12.6572 9.62402L11.3105 11.7539L9.83594 10.1201C9.53995 9.79217 9.03405 9.76562 8.70605 10.0615C8.37812 10.3575 8.35256 10.8634 8.64844 11.1914L10.8301 13.6094C10.9978 13.7951 11.2428 13.8915 11.4922 13.8701C11.7415 13.8488 11.9669 13.7125 12.1006 13.501L14.0098 10.4785L14.9639 8.96777L15.4414 8.21289C15.6774 7.83936 15.5659 7.34439 15.1924 7.1084Z"
        fill="currentColor"
      />
    </svg>
  );
}
