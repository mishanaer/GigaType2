import React from "react";
import { Home, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";

export type ControlPanelView = "home";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  updateAction?: React.ReactNode;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  updateAction,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const navItems: {
    id: ControlPanelView;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { id: "home", label: t("sidebar.home"), icon: Home },
  ];

  return (
    <div className="w-48 h-full shrink-0 border-r border-border/15 dark:border-white/6 flex flex-col bg-muted/60 dark:bg-muted">
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <nav className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-left",
                "focus-visible:ring-1 focus-visible:ring-primary/30",
                isActive
                  ? "bg-primary/8 dark:bg-primary/10"
                  : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
              )}
            >
              <Icon
                size={15}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive
                    ? "text-primary"
                    : "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/55 dark:group-hover:text-foreground/70"
                )}
              />
              <span
                className={cn(
                  "text-xs transition-colors duration-150",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-foreground/80 group-hover:text-foreground dark:text-foreground/75 dark:group-hover:text-foreground/90"
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-2 pb-2 space-y-0.5">
        {updateAction && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
        >
          <Settings
            size={15}
            className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
          />
          <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
            {t("sidebar.settings")}
          </span>
        </button>

      </div>
    </div>
  );
}
