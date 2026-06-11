import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import PermissionsSection from "./ui/PermissionsSection";
import { usePermissions } from "../hooks/usePermissions";
import { getCachedPlatform } from "../utils/platform";
import { areRequiredPermissionsMet } from "../utils/permissions";

interface PostMigrationOnboardingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

export default function PostMigrationOnboarding({
  open,
  onOpenChange,
  onDone,
}: PostMigrationOnboardingProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const permissionsReady = areRequiredPermissionsMet(
    permissions.micPermissionGranted,
    getCachedPlatform(),
    permissions.accessibilityPermissionGranted
  );

  const remindLater = () => {
    window.electronAPI?.markBundleMigrationDismissed?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("postMigration.title")}</DialogTitle>
          <DialogDescription>{t("postMigration.description")}</DialogDescription>
        </DialogHeader>

        <PermissionsSection permissions={permissions} />

        <DialogFooter>
          <Button variant="ghost" onClick={remindLater}>
            {t("postMigration.remindLater")}
          </Button>
          <Button onClick={onDone} disabled={!permissionsReady}>
            {t("postMigration.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
