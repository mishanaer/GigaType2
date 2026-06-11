import React from "react"

import SettingsPage, { SettingsSectionType } from "./SettingsPage"
import { SettingsLayoutProvider } from "./ui/useSettingsLayout"

export type { SettingsSectionType }

interface SettingsWorkspaceProps {
  requestedSection?: string
  requestId?: number
}

export default function SettingsWorkspace({
  requestedSection: _requestedSection,
  requestId: _requestId,
}: SettingsWorkspaceProps) {
  const [isCompact, setIsCompact] = React.useState(false)
  const observerRef = React.useRef<ResizeObserver | null>(null)

  const containerRef = React.useCallback((el: HTMLElement | null) => {
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

  return (
    <main
      ref={containerRef}
      className="h-full min-h-0 w-full overflow-y-auto bg-background"
    >
      <SettingsLayoutProvider value={{ isCompact }}>
        <div className={isCompact ? "p-4" : "p-6"}>
          <SettingsPage activeSection={"general" satisfies SettingsSectionType} />
        </div>
      </SettingsLayoutProvider>
    </main>
  )
}
