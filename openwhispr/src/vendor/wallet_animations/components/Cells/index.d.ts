import * as React from "react";

type CellProps<T extends React.ElementType = "div"> = {
  as?: T;
  start?: React.ReactNode;
  end?: React.ReactNode;
  onClick?: () => void;
  children?: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "start" | "end" | "onClick" | "children">;

interface CellTextProps {
  type?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  caption?: React.ReactNode;
  bold?: boolean;
}

interface CellEndProps {
  label?: string;
  caption?: string;
}

interface CellStartProps {
  type: string;
  src?: string | null;
  iconType?: React.ReactNode;
}

interface CellPartProps {
  type: string;
  className?: string;
  children?: React.ReactNode;
}

type SwitchCellProps = {
  start?: React.ReactNode;
  children?: React.ReactNode;
  value?: boolean;
  defaultValue?: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange">;

type CellComponent = (<T extends React.ElementType = "div">(
  props: CellProps<T>
) => React.ReactElement) & {
  Start: React.FC<CellStartProps>;
  Text: React.FC<CellTextProps>;
  End: React.FC<CellEndProps>;
  Part: React.FC<CellPartProps>;
  Switch: React.FC<SwitchCellProps>;
};

export const Cell: CellComponent;
export default Cell;
