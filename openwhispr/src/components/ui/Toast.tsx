import * as React from "react"

import { Toaster } from "@/components/ui/sonner"

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const isDictationPanel =
    window.location.pathname.indexOf("control") === -1 &&
    window.location.search.indexOf("panel=true") === -1

  return (
    <>
      {children}
      <Toaster
        closeButton
        richColors
        position={isDictationPanel ? "bottom-center" : "bottom-right"}
      />
    </>
  )
}
