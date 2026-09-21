import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const LEGACY_SCHEMA_HASHES: Record<string, string> = {
  agent_continue: "960620ecca49cb20148ebc2c56a25c43324a3a9174a548cf63e8f5eaf5020602",
  agent_list: "feac5a11367d46fd0ad574ae8b81cd1e186bf468f63dda0f2bf330ad23a18674",
  agent_spawn: "6f18e2ad17032c790c608b7f5cb9184a0a871288d4186ca224b6e80bc3a9af56",
  agent_status: "161bb06196640220afff14b9555e63dd4b38674879f5a85aab1c90da9d4b500b",
  agent_wait: "9f10e251bd5b98e5cc5dea8f585f0d5165ff6adfd76698b3ec01fe72008ad7aa",
  apply_patch: "08b56637f47f6d7fa3207956a607771d50bc928a4d9d8aaf9b0381916e9ff28d",
  bash: "c662f53a8b7b4ccedd5756bfb8156387a10667f240dfcc00ca81b62d3b1defc8",
  call_upstream_mcp_tool: "fd8fad70e2eb120fdcfa973d76d0f95839e07fab2bdf4f10d00b0a52658f106b",
  devspace_admin_call: "685ae3b25d69d000a2ea67732de7ff3f45a94a5ad9614092ae5693352f5f2fd6",
  devspace_admin_status: "5e2a1151d9282ca6c945ec7086bf6b7f77b04fd7ce59173364dd88e665af38d2",
  edit: "0d9e57b0b3e21ee82c3dc90096f9112900af5d9fafe14645880f5253e590ed4c",
  exec_command: "8cc74834f3dec6af8bd5ee729aa83b869ff75366fe914216d260230ed93bfd7a",
  get_upstream_mcp_status: "5163b90dadf6048e2cab69bc0ede11542e5d9dfed87adc9b8f1a07584c444147",
  git_add: "f570b2b58d8c71aaacc6bbb84ab402e83b819918b790a8d0d2951b13c6175a57",
  git_commit: "3a53df6fa9bb7dd3237d21086abe3d8494b12fa3df7b379b9f2102322ce3d874",
  git_pull: "866be43a50a7d24f375f721685ca34537c3d7554016a79f75e5920394429a46c",
  git_push: "b0f2bc57c1d1eea5127f83fa8a323a92d37023f8f534009717499d7f27ca67f8",
  git_status: "ad6db57338071966dc905dd400023ebad11db346b9ab26c6defa794af2f26b0e",
  glob: "b9bee447a6a84da49729ea58c92aff6493d882c097a141bedba281b2799def14",
  grep: "b69cc6bb79dbe3279593db4a42cb96b5ddd43f29dfb15c8f420e5343e862a2bc",
  list_upstream_mcp_tools: "405cf3af4c51358b02c2ad3995539e70ef771b566ac03cd3c96f314458a1a46c",
  ls: "dc688a568acb90ae493e9e9499820ee7bed2c1e2e9c13dc5c3e92365cca84f82",
  open_workspace: "d63e3c89eb6d5f3a7134ef36b0b567b916b2fe5d73c6e0ae48cf0c1b2b5a8a1e",
  read: "b42042436d6bb7ab954b24b6b7a0c8c1971a0229e43e3df5985d996dfeaabc62",
  write: "437a659620daa71b9b9ed25bb33d1bef26e150b43d286d922d90824f66b868b3",
  write_stdin: "7134edb36852706ea0e892b57afd8db8b9cb0c6a4d7e9e067188f09e9cc05904",
};

const COMMON_TOOLS = [
  "call_upstream_mcp_tool",
  "devspace_admin_call",
  "devspace_admin_status",
  "get_upstream_mcp_status",
  "git_add",
  "git_commit",
  "git_pull",
  "git_push",
  "git_status",
  "list_upstream_mcp_tools",
  "open_workspace",
  "read",
] as const;

const SUBAGENT_TOOLS = [
  "agent_continue",
  "agent_list",
  "agent_spawn",
  "agent_status",
  "agent_wait",
] as const;

const MODE_TOOLS = {
  full: ["bash", "edit", "glob", "grep", "ls", "write"],
  minimal: ["bash", "edit", "write"],
  codex: ["apply_patch", "exec_command", "write_stdin"],
} as const;

type ToolMode = keyof typeof MODE_TOOLS;

for (const mode of Object.keys(MODE_TOOLS) as ToolMode[]) {
  for (const subagents of [false, true]) {
    test(`legacy MCP schemas remain compatible in ${mode} mode with subagents ${subagents ? "on" : "off"}`, async () => {
      const fixture = await createFixture(mode, subagents);
      try {
        const listed = await fixture.client.listTools();
        const current = new Map(listed.tools.map((tool) => [tool.name, tool]));
        const expectedNames = [
          ...COMMON_TOOLS,
          ...MODE_TOOLS[mode],
          ...(subagents ? SUBAGENT_TOOLS : []),
        ];

        for (const name of expectedNames) {
          const tool = current.get(name);
          assert.ok(tool, `legacy tool ${name} must remain registered`);
          assert.equal(
            schemaHash({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }),
            LEGACY_SCHEMA_HASHES[name],
            `legacy tool ${name} input/output schema changed`,
          );
        }
      } finally {
        await fixture.close();
      }
    });
  }
}

async function createFixture(mode: ToolMode, subagents: boolean): Promise<{
  client: Client;
  config: ServerConfig;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "devspace-tool-surface-"));
  const agentDir = join(root, "agent");
  const stateDir = join(root, "state");
  await mkdir(agentDir, { recursive: true });

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: mode,
    DEVSPACE_SUBAGENTS: subagents ? "1" : "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-surface-compat", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    config,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function schemaHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
