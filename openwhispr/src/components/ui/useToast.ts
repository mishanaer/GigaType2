import * as React from "react"
import { toast as sonnerToast } from "sonner"

export interface ToastProps {
  id?: string
  title?: string
  description?: string
  action?: React.ReactNode
  variant?: "default" | "destructive" | "success"
  duration?: number
  onClose?: () => void
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => string
  dismiss: (id?: string) => void
  toastCount: number
}

const renderMessage = (title?: string, description?: string) =>
  title || description || ""

const activeToastIds = new Set<string>()

const isDictationPanel = () =>
  typeof window !== "undefined" &&
  window.location.pathname.indexOf("control") === -1 &&
  window.location.search.indexOf("panel=true") === -1

const syncDictationToastWindow = () => {
  if (!isDictationPanel()) return
  if (activeToastIds.size > 0) {
    window.electronAPI?.setMainWindowInteractivity?.(true)
    window.electronAPI?.resizeMainWindow?.("WITH_TOAST")
  } else {
    window.electronAPI?.setMainWindowInteractivity?.(false)
    window.electronAPI?.resizeMainWindow?.("BASE")
  }
}

const removeToast = (id?: string) => {
  if (id) {
    activeToastIds.delete(id)
  } else {
    activeToastIds.clear()
  }
  syncDictationToastWindow()
}

export const useToast = (): ToastContextType => {
  const toast = React.useCallback((props: Omit<ToastProps, "id">): string => {
    const { title, description, action, duration, onClose, variant = "default" } = props

    if (isDictationPanel() && variant === "destructive") {
      onClose?.()
      return ""
    }

    let toastId = ""
    const options = {
      description: title ? description : undefined,
      action,
      duration,
      onAutoClose: () => {
        removeToast(toastId)
        onClose?.()
      },
      onDismiss: () => {
        removeToast(toastId)
        onClose?.()
      },
    }
    const message = renderMessage(title, description)
    const id =
      variant === "destructive"
        ? sonnerToast.error(message, options)
        : variant === "success"
          ? sonnerToast.success(message, options)
          : sonnerToast(message, options)

    toastId = String(id)
    activeToastIds.add(toastId)
    syncDictationToastWindow()
    return toastId
  }, [])

  const dismiss = React.useCallback((id?: string) => {
    sonnerToast.dismiss(id)
    removeToast(id)
  }, [])

  return { toast, dismiss, toastCount: activeToastIds.size }
}
