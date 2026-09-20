import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevSpaceModuleRegistry } from "./registry.js";

export function registerModuleStatusTool(server: McpServer, registry: DevSpaceModuleRegistry): void {
  server.registerTool(
    "get_devspace_module_status",
    {
      title: "DevSpace Module Status",
      description:
        "Report DevSpace core health and the registration state of secondary modules. A failed or unavailable secondary module does not make the core server unavailable.",
      inputSchema: {},
    },
    async () => {
      const state = {
        core: { id: "core", status: "ready" as const },
        modules: registry.list(),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(state) }],
        structuredContent: state,
      };
    },
  );
}
