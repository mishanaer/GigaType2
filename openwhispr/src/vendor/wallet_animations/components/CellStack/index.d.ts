import * as React from "react";

interface CellStackProps {
  children: React.ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  ariaLabel?: string;
}

interface CellStackComponent extends React.FC<CellStackProps> {
  Morph: React.FC<{ children: React.ReactNode; rotateEndOnExpand?: boolean }>;
}

declare const CellStack: CellStackComponent;

export default CellStack;
