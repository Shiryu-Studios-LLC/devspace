import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const IMPORT = 'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";';
const CONFIG_MARKER = "DEVSPACE UPSTREAM STDIO CONFIGURATION";
const CLIENT_MARKER = "DEVSPACE UPSTREAM STDIO CLIENT POOL";

export function repairUpstreamMcpRuntime(rootDir) {
  const files = [resolve(rootDir, "dist/upstream-mcp.js"), resolve(rootDir, "dist/hot-modules.mjs")];
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`Expected DevSpace gateway module is missing: ${file}`);
    let source = readFileSync(file, "utf8");
    if (!source.includes(IMPORT)) {
      const httpImport = 'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";';
      if (!source.includes(httpImport)) throw new Error(`Cannot find HTTP MCP transport import in ${file}`);
      source = source.replace(httpImport, httpImport + "\n" + IMPORT);
    }
    source = source.replace(/^(?:var|const) (?:stdioUpstreamClients|stdioClients) = new Map\(\);\n/m, "");
    if (!source.includes("const stdioUpstreamClients = new Map();")) {
      source = source.replace("function configuredUpstreams(config) {", "const stdioUpstreamClients = new Map();\nfunction configuredUpstreams(config) {");
    }
    source = replaceBlock(source, /function configuredUpstreams\(config\) \{[\s\S]*?(?=\nasync function withClient)/, configuredBlock(), CONFIG_MARKER, file);
    source = replaceBlock(source, /async function withClient\(upstream, action, options = \{\}\) \{[\s\S]*?(?=\n(?:export )?(?:async )?function (?:closeUpstreamMcpClients|errorResult))/, clientBlock(), CLIENT_MARKER, file);
    source = source.replace(/client\.ping\(\)/g, "client.ping({ timeout: requestTimeoutMs })");
    source = source.replace(/client\.listTools\(\)/g, "client.listTools({}, { timeout: requestTimeoutMs })");
    source = source.replace(/client\.callTool\(\{ name: toolName, arguments: args \}\)/g, "client.callTool({ name: toolName, arguments: args }, undefined, { timeout: requestTimeoutMs })");
    source = source.replace(/\(client\) => client\.ping\(\{ timeout: requestTimeoutMs \}\)/g, "(client, requestTimeoutMs) => client.ping({ timeout: requestTimeoutMs })");
    source = source.replace(/\(client\) => client\.listTools\(\{\}, \{ timeout: requestTimeoutMs \}\)/g, "(client, requestTimeoutMs) => client.listTools({}, { timeout: requestTimeoutMs })");
    source = source.replace(/\(client\) => client\.callTool\(\{ name: toolName, arguments: args \}, (?:void 0|undefined), \{ timeout: requestTimeoutMs \}\)/g, "(client, requestTimeoutMs) => client.callTool({ name: toolName, arguments: args }, undefined, { timeout: requestTimeoutMs })");
    writeFileSync(file, source);
  }
  return files;
}

function configuredBlock() {
  return `function configuredUpstreams(config) {
  return config.upstreamMcpServers.flatMap((entry) => {
    if (typeof entry.name !== "string" || !entry.name.trim()) return [];
    if (typeof entry.command === "string" && entry.command.trim()) {
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) return [];
      if (entry.env !== undefined && (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env) || Object.values(entry.env).some((value) => typeof value !== "string"))) return [];
      return [{ name: entry.name, command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, cwd: entry.cwd, enabled: entry.enabled !== false, startupTimeoutMs: entry.startupTimeoutMs ?? 30000, requestTimeoutMs: entry.requestTimeoutMs ?? 450000, transport: "stdio" }];
    }
    try {
      const url = new URL(entry.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
      return [{ name: entry.name, url, enabled: entry.enabled !== false, transport: "http" }];
    } catch {
      return [];
    }
  });
}`;
}

function clientBlock() {
  return `async function withClient(upstream, action, options = {}) {
  if (upstream.transport === "stdio") {
    let clientPromise = stdioUpstreamClients.get(upstream.name);
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });
        const transport = new StdioClientTransport({ command: upstream.command, args: upstream.args, env: upstream.env, cwd: upstream.cwd, stderr: "inherit" });
        let timer;
        try {
          await Promise.race([client.connect(transport), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MCP server " + upstream.name + " did not start within " + upstream.startupTimeoutMs + " ms.")), upstream.startupTimeoutMs); timer.unref?.(); })]);
          return { client, transport };
        } catch (error) {
          await transport.close().catch(() => undefined);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      })();
      stdioUpstreamClients.set(upstream.name, clientPromise);
      clientPromise.catch(() => { if (stdioUpstreamClients.get(upstream.name) === clientPromise) stdioUpstreamClients.delete(upstream.name); });
    }
    const connected = await clientPromise;
    return action(connected.client, options.timeoutMs ?? upstream.requestTimeoutMs);
  }
  const client = new Client({ name: "devspace-upstream-bridge", version: "1.0.0" });
  const requestInit = options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : undefined;
  const transport = new StreamableHTTPClientTransport(upstream.url, requestInit ? { requestInit } : undefined);
  try {
    await client.connect(transport);
    return await action(client, options.timeoutMs);
  } finally {
    await transport.close().catch(() => undefined);
  }
}`;
}

function replaceBlock(source, pattern, block, marker, file) {
  const matching = source.match(pattern);
  if (source.includes(marker)) {
    if (!matching) throw new Error(`Patched MCP gateway block is missing from ${file}`);
    return source;
  }
  if (!matching) throw new Error(`Cannot locate MCP gateway block in ${file}`);
  return source.replace(pattern, `${block}\n/* ${marker} */`);
}
