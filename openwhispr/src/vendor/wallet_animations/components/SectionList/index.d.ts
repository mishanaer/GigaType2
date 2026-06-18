import * as React from "react";

interface SectionListProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

interface SectionListItemProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  header?: string;
  description?: string;
}

type SectionListComponent = React.FC<SectionListProps> & {
  Item: React.FC<SectionListItemProps>;
};

declare const SectionList: SectionListComponent;
export default SectionList;
