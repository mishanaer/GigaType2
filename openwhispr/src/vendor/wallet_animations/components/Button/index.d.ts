import * as React from "react";

export interface RegularButtonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "filled" | "tinted" | "plain" | "gray" | "disabled" | "outlined";
  label: string;
  isShine?: boolean;
  isFill?: boolean;
}

export const RegularButton: React.FC<RegularButtonProps>;
