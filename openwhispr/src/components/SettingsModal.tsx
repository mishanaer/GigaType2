import React, { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Keyboard, Mic, Shield, Sliders, Wrench, X } from "lucide-react"

import SettingsPage, { SettingsSectionType } from "./SettingsPage"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "./ui/dialog"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "./ui/sidebar"
import { SettingsLayoutProvider } from "./ui/useSettingsLayout"

export type { SettingsSectionType }

interface SidebarItem<T extends string> {
  id: T
  label: string
  icon: React.ComponentType<{ className?: string }>
  group?: string
  description?: string
  badge?: string
  badgeVariant?: "default" | "new" | "update" | "dot"
  shortcut?: string
}

const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  transcription: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
}

const LEGACY_SUB_TAB: Record<string, string> = {
  transcription: "dictation",
}

const REMOVED_SECTIONS = new Set([
  "account",
  "agentConfig",
  "agentMode",
  "aiModels",
  "chat",
  "integrations",
  "intelligence",
  "llms",
  "meetings",
  "notes",
  "plansBilling",
  "support",
  "upload",
  "uploads",
  "workspace",
])

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: string
}

export default function SettingsModal({
  open,
  onOpenChange,
  initialSection,
}: SettingsModalProps) {
  const { t } = useTranslation()
  const [isCompact, setIsCompact] = React.useState(false)
  const observerRef = React.useRef<ResizeObserver | null>(null)

  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(
    () => [
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Keyboard,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "speechToText",
        label: t("settingsModal.sections.speechToText.label"),
        icon: Mic,
        description: t("settingsModal.sections.speechToText.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "privacyData",
        label: t("settingsModal.sections.privacyData.label"),
        icon: Shield,
        description: t("settingsModal.sections.privacyData.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "system",
        label: t("settingsModal.sections.system.label"),
        icon: Wrench,
        description: t("settingsModal.sections.system.description"),
        group: t("settingsModal.groups.system"),
      },
    ],
    [t]
  )

  const resolveSection = (section: string | undefined): SettingsSectionType => {
    if (!section) return "general"
    const resolved = SECTION_ALIASES[section] ?? section
    if (REMOVED_SECTIONS.has(resolved)) return "general"
    return resolved as SettingsSectionType
  }

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>(() =>
    resolveSection(initialSection)
  )
  const [initialSubTab, setInitialSubTab] = useState<string | undefined>(() =>
    initialSection ? LEGACY_SUB_TAB[initialSection] : undefined
  )
  const [prevOpen, setPrevOpen] = useState(open)

  if (open && !prevOpen && initialSection) {
    setPrevOpen(open)
    setActiveSection(resolveSection(initialSection))
    setInitialSubTab(LEGACY_SUB_TAB[initialSection])
  } else if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setInitialSubTab(undefined)
  }

  const groupedItems = React.useMemo(() => {
    const groups: { label: string | null; items: SidebarItem<SettingsSectionType>[] }[] = []
    let currentGroup: string | null | undefined = undefined

    for (const item of sidebarItems) {
      const group = item.group ?? null
      if (group !== currentGroup) {
        groups.push({ label: group, items: [item] })
        currentGroup = group
      } else {
        groups[groups.length - 1].items.push(item)
      }
    }

    return groups
  }, [sidebarItems])

  const containerRef = React.useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setIsCompact(width > 0 && width < 800)
    })
    observer.observe(el)
    observerRef.current = observer
  }, [])

  const handleSectionChange = (section: SettingsSectionType) => {
    setActiveSection(section)
    setInitialSubTab(undefined)
  }

  const renderBadge = (item: SidebarItem<SettingsSectionType>) => {
    if (!item.badge && item.badgeVariant !== "dot") return null
    if (item.badgeVariant === "dot") {
      return <span className="ml-auto size-1.5 rounded-full bg-primary" />
    }
    return <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (document.querySelector("[data-capturing]")) event.preventDefault()
        }}
        className="flex h-[85vh] max-h-[85vh] w-[90vw] !max-w-4xl flex-col gap-0 overflow-hidden rounded-lg border bg-background p-0 shadow-lg"
      >
        <DialogTitle className="sr-only">{t("settingsModal.title")}</DialogTitle>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-4 top-4 z-10 text-muted-foreground"
          >
            <X className="size-4" />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </DialogClose>

        <SidebarProvider
          defaultOpen
          className="h-full min-h-0 w-full overflow-hidden"
          style={
            {
              "--sidebar-width": isCompact ? "3.25rem" : "13rem",
              "--sidebar-width-icon": "3.25rem",
            } as React.CSSProperties
          }
        >
          <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-1">
            <Sidebar
              collapsible="none"
              className="h-full min-h-0 shrink-0 border-r border-sidebar-border"
            >
              <SidebarContent
                className={isCompact ? "h-full overflow-y-auto px-1.5 py-4" : "h-full overflow-y-auto px-2 py-4"}
              >
                {groupedItems.map((group, groupIndex) => (
                  <SidebarGroup key={groupIndex} className={groupIndex > 0 ? "mt-2" : ""}>
                    {!isCompact && group.label ? (
                      <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                    ) : null}
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {group.items.map((item) => {
                          const Icon = item.icon
                          const isActive = activeSection === item.id

                          return (
                            <SidebarMenuItem key={item.id}>
                              <SidebarMenuButton
                                isActive={isActive}
                                tooltip={isCompact ? item.label : undefined}
                                title={isCompact ? item.label : undefined}
                                onClick={() => handleSectionChange(item.id)}
                                className={
                                  isCompact
                                    ? "justify-center px-0 [&>span]:hidden"
                                    : "gap-2.5"
                                }
                              >
                                <Icon className="size-4" />
                                <span>{item.label}</span>
                                {!isCompact ? renderBadge(item) : null}
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          )
                        })}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                ))}
              </SidebarContent>
            </Sidebar>

            <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
              <SettingsLayoutProvider value={{ isCompact }}>
                <div className={isCompact ? "p-4" : "p-6"}>
                  <SettingsPage
                    activeSection={activeSection}
                    onNavigateToSection={handleSectionChange}
                    initialSubTab={initialSubTab}
                  />
                </div>
              </SettingsLayoutProvider>
            </main>
          </div>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
