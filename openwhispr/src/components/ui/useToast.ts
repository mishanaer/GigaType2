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

export const useToast = (): ToastContextType => {
  const toast = React.useCallback((props: Omit<ToastProps, "id">): string => {
    const { title, description, action, duration, onClose, variant = "default" } = props
    const options = {
      description: title ? description : undefined,
      action,
      duration,
      onAutoClose: onClose ? () => onClose() : undefined,
      onDismiss: onClose ? () => onClose() : undefined,
    }
    const message = renderMessage(title, description)
    const id =
      variant === "destructive"
        ? sonnerToast.error(message, options)
        : variant === "success"
          ? sonnerToast.success(message, options)
          : sonnerToast(message, options)

    return String(id)
  }, [])

  const dismiss = React.useCallback((id?: string) => {
    sonnerToast.dismiss(id)
  }, [])

  return { toast, dismiss, toastCount: 0 }
}
