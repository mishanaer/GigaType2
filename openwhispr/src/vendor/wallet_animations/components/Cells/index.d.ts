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
  title?: string;
  description?: string;
  caption?: string;
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

type CellComponent = (<T extends React.ElementType = "div">(props: CellProps<T>) => React.ReactElement) & {
  Start: React.FC<CellStartProps>;
  Text: React.FC<CellTextProps>;
  End: React.FC<CellEndProps>;
  Part: React.FC<CellPartProps>;
};

export const Cell: CellComponent;
export default Cell;
