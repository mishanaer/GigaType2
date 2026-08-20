import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createSearchNotesTool());
  registry.register(getNoteTool);
  registry.register(createNoteTool);
  registry.register(updateNoteTool);
  registry.register(listFoldersTool);
  registry.register(clipboardTool);

  return registry;
}
