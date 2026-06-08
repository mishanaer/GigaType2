import React, { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Shield, Sliders, Wrench } from "lucide-react"

import SettingsPage, { SettingsSectionType } from "./SettingsPage"
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
  hotkeys: "general",
  speechToText: "general",
  transcription: "general",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
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

interface SettingsWorkspaceProps {
  requestedSection?: string
  requestId?: number
}

export default function SettingsWorkspace({
  requestedSection,
  requestId,
}: SettingsWorkspaceProps) {
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
    resolveSection(requestedSection)
  )

  useEffect(() => {
    if (requestId === undefined) return
    setActiveSection(resolveSection(requestedSection))
  }, [requestedSection, requestId])

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
  }

  const renderBadge = (item: SidebarItem<SettingsSectionType>) => {
    if (!item.badge && item.badgeVariant !== "dot") return null
    if (item.badgeVariant === "dot") {
      return <span className="ml-auto size-1.5 rounded-full bg-primary" />
    }
    return <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
  }

  return (
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
            className={
              isCompact ? "h-full overflow-y-auto px-1.5 py-4" : "h-full overflow-y-auto px-2 py-4"
            }
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
                              isCompact ? "justify-center px-0 [&>span]:hidden" : "gap-2.5"
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
              />
            </div>
          </SettingsLayoutProvider>
        </main>
      </div>
    </SidebarProvider>
  )
}
