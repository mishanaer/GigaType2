import * as React from "react";

export interface SwitchProps {
  value?: boolean;
  defaultValue?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

declare const Switch: React.FC<SwitchProps>;

export default Switch;
