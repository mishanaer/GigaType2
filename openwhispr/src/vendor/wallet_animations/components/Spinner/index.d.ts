import * as React from "react";

interface SpinnerProps extends React.SVGProps<SVGSVGElement> {
  centered?: boolean;
  className?: string;
  size?: number;
}

declare const Spinner: React.FC<SpinnerProps>;
export default Spinner;
