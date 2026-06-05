import * as React from "react"

import { Switch } from "@/components/ui/switch"

type ToggleProps = Omit<
  React.ComponentProps<typeof Switch>,
  "checked" | "onCheckedChange" | "onChange"
> & {
  checked?: boolean
  onChange?: (checked: boolean) => void | Promise<void>
  pressed?: boolean
  onPressedChange?: (pressed: boolean) => void | Promise<void>
}

function Toggle({
  checked,
  onChange,
  pressed,
  onPressedChange,
  ...props
}: ToggleProps) {
  return (
    <Switch
      checked={checked ?? pressed}
      onCheckedChange={onChange ?? onPressedChange}
      {...props}
    />
  )
}

export { Toggle }
