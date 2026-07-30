import { createContext, useContext } from "react";

const CellStackContext = createContext({ expanded: false, spring: undefined });

export const useCellStack = () => useContext(CellStackContext);

export default CellStackContext;
