import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";

const serverUrl = new URL(process.env.DEVSPACE_REVAMP_E2E_URL ?? "http://127.0.0.1:7677/mcp");
const redirectUrl = new URL(process.env.DEVSPACE_REVAMP_E2E_REDIRECT ?? "/e2e-callback", serverUrl);
const ownerToken = process.env.DEVSPACE_REVAMP_E2E_OWNER_TOKEN ?? "devspace-revamp-e2e-owner-token";
const workspacePath = process.env.DEVSPACE_REVAMP_E2E_WORKSPACE ?? process.cwd();

const discovered = await discoverOAuthServerInfo(serverUrl);
const clientInformation = await registerClient(discovered.authorizationServerUrl, {
  metadata: discovered.authorizationServerMetadata,
  clientMetadata: {
    client_name: "DevSpace Revamp E2E",
    redirect_uris: [redirectUrl.href],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
});

const authorization = await startAuthorization(discovered.authorizationServerUrl, {
  metadata: discovered.authorizationServerMetadata,
  clientInformation,
  redirectUrl,
  scope: "devspace",
  state: "revamp-e2e",
  resource: serverUrl,
});

const approvalParams = new URLSearchParams(authorization.authorizationUrl.searchParams);
approvalParams.set("owner_token", ownerToken);
const approval = await fetch(authorization.authorizationUrl, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: approvalParams,
  redirect: "manual",
});
if (approval.status !== 302) {
  throw new Error(`authorization approval failed: ${approval.status} ${await approval.text()}`);
}

const redirectLocation = approval.headers.get("location");
if (!redirectLocation) throw new Error("authorization redirect missing");
const authorizationCode = new URL(redirectLocation).searchParams.get("code");
if (!authorizationCode) throw new Error("authorization code missing from redirect");

const tokens = await exchangeAuthorization(discovered.authorizationServerUrl, {
  metadata: discovered.authorizationServerMetadata,
  clientInformation,
  authorizationCode,
  codeVerifier: authorization.codeVerifier,
  redirectUri: redirectUrl,
  resource: serverUrl,
});

const transport = new StreamableHTTPClientTransport(serverUrl, {
  requestInit: {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  },
});
const client = new Client({ name: "devspace-revamp-e2e", version: "1.0.0" });
await client.connect(transport);

try {
  const tools = await client.listTools();
  const status = await client.callTool({
    name: "get_devspace_module_status",
    arguments: {},
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspacePath, mode: "checkout" },
  });

  const workspaceId = opened.structuredContent?.workspaceId;
  if (typeof workspaceId !== "string") throw new Error("open_workspace did not return a workspaceId");
  if (status.isError) throw new Error("get_devspace_module_status returned an MCP error");
  const modules = Array.isArray(status.structuredContent?.modules)
    ? status.structuredContent.modules
    : [];
  const upstream = modules.find((module) => module?.id === "upstream-mcp");

  console.log(JSON.stringify({
    oauth: {
      registered: true,
      authorized: true,
      accessTokenIssued: Boolean(tokens.access_token),
      refreshTokenIssued: Boolean(tokens.refresh_token),
    },
    mcp: {
      connected: true,
      toolCount: tools.tools.length,
      hasModuleStatus: tools.tools.some((tool) => tool.name === "get_devspace_module_status"),
      workspaceOpened: true,
      workspaceId,
      upstream: upstream
        ? {
            status: upstream.status,
            detail: upstream.detail,
            capabilities: upstream.capabilities,
          }
        : null,
    },
  }, null, 2));
} finally {
  await client.close();
}
