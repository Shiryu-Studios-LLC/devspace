import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSessionConfigured,
  createBrowserSessionProvider,
  normalizeLoopbackEndpoint,
} from "./desktop-browser-session.js";

test("browser session provider returns bounded metadata without debugger URLs or URL secrets", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/json/version")) {
      return jsonResponse({ Browser: "Opera/123.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/browser/secret" });
    }
    return jsonResponse([
      {
        id: "page-1",
        type: "page",
        title: "Inbox",
        url: "https://example.com/mail?token=secret#message",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/secret",
      },
      {
        id: "page-2",
        type: "page",
        title: "Local file",
        url: "file:///home/user/private.txt",
      },
    ]);
  }) as typeof fetch;

  const provider = createBrowserSessionProvider({
    endpoint: "http://127.0.0.1:9222",
    fetchImpl,
    now: () => new Date("2026-09-21T03:40:00.000Z"),
  });
  const snapshot = await provider();

  assert.deepEqual(requested.sort(), [
    "http://127.0.0.1:9222/json/list",
    "http://127.0.0.1:9222/json/version",
  ]);
  assert.deepEqual(snapshot, {
    browser: "Opera/123.0",
    capturedAt: "2026-09-21T03:40:00.000Z",
    tabs: [
      { id: "page-1", type: "page", title: "Inbox", url: "https://example.com/mail" },
      { id: "page-2", type: "page", title: "Local file", url: "file://[local-file]" },
    ],
  });
  assert.equal(JSON.stringify(snapshot).includes("webSocketDebuggerUrl"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("browser session endpoint must be explicitly configured on loopback", () => {
  assert.equal(browserSessionConfigured(undefined), false);
  assert.equal(browserSessionConfigured("http://127.0.0.1:9222"), true);
  assert.equal(browserSessionConfigured("http://localhost:9222"), true);
  assert.equal(browserSessionConfigured("https://[::1]:9222"), true);
  assert.equal(browserSessionConfigured("https://example.com:9222"), false);
  assert.throws(() => normalizeLoopbackEndpoint(undefined), /explicitly configured/);
  assert.throws(() => normalizeLoopbackEndpoint("https://example.com:9222"), /loopback/);
  assert.throws(() => normalizeLoopbackEndpoint("ws://127.0.0.1:9222"), /http or https/);
  assert.throws(() => normalizeLoopbackEndpoint("http://user:pass@127.0.0.1:9222"), /credentials/);
});

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body, "utf8")),
    },
  });
}
