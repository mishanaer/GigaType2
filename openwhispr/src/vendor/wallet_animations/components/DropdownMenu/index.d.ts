import * as React from "react";

interface DropdownMenuProps {
  items: string[];
  trigger?: React.ReactNode;
}

declare const DropdownMenu: React.FC<DropdownMenuProps>;
export default DropdownMenu;
