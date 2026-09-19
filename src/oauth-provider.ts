import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const cleanScopes = params.scopes.filter(Boolean);
  const scopeText = cleanScopes.length > 0 ? cleanScopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<div class="error" role="alert"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>${htmlEscape(params.error)}</span></div>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      :root {
        --bg: #090d16;
        --card-bg: #111827;
        --card-border: #1e293b;
        --text: #f1f5f9;
        --text-muted: #94a3b8;
        --text-dim: #64748b;
        --primary: #38bdf8;
        --primary-hover: #0ea5e9;
        --input-bg: #030712;
        --input-border: #334155;
        --input-focus: #38bdf8;
        --danger-bg: rgba(239, 68, 68, 0.15);
        --danger-border: #ef4444;
        --danger-text: #fca5a5;
        --info-bg: #0b1329;
        --info-border: #1e293b;
      }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(circle at top center, #1e293b 0%, var(--bg) 70%);
        color: var(--text);
        padding: 20px;
      }
      main {
        width: 100%;
        max-width: 440px;
        padding: 32px;
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 20px;
        box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.6);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }
      .brand-icon {
        width: 36px;
        height: 36px;
        background: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%);
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #030712;
        font-weight: 800;
        font-size: 18px;
      }
      h1 { margin: 0; font-size: 22px; font-weight: 700; }
      .description {
        margin: 0 0 20px;
        font-size: 14px;
        line-height: 1.5;
        color: var(--text-muted);
      }
      .error {
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--danger-bg);
        border: 1px solid var(--danger-border);
        color: var(--danger-text);
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 20px;
        font-size: 14px;
      }
      .error svg { flex-shrink: 0; }
      .details {
        margin: 0 0 22px;
        padding: 14px 16px;
        background: var(--info-bg);
        border: 1px solid var(--info-border);
        border-radius: 12px;
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px 14px;
        font-size: 13px;
      }
      .details dt { color: var(--text-dim); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; align-self: center; }
      .details dd { margin: 0; word-break: break-all; color: var(--text); }
      label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
      .input-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      input[type="password"], input[type="text"] {
        width: 100%;
        padding: 12px 42px 12px 14px;
        border-radius: 10px;
        border: 1px solid var(--input-border);
        background: var(--input-bg);
        color: var(--text);
        font-size: 15px;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      input:focus {
        border-color: var(--input-focus);
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
      }
      .toggle-btn {
        position: absolute;
        right: 10px;
        background: transparent;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .toggle-btn:hover { color: var(--text); }
      button[type="submit"] {
        margin-top: 20px;
        width: 100%;
        border: none;
        border-radius: 10px;
        padding: 13px;
        font-size: 15px;
        font-weight: 700;
        color: #030712;
        background: var(--primary);
        cursor: pointer;
        transition: background-color 0.15s ease, transform 0.05s ease;
      }
      button[type="submit"]:hover { background: var(--primary-hover); }
      button[type="submit"]:active { transform: scale(0.99); }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <div class="brand-icon">D</div>
        <h1>Connect DevSpace</h1>
      </div>
      <p class="description">Approve <strong>${htmlEscape(params.clientName)}</strong> to access your local DevSpace development environment.</p>
      ${error}
      <dl class="details">
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner Password</label>
        <div class="input-wrap">
          <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required placeholder="Enter owner token" />
          <button type="button" class="toggle-btn" aria-label="Toggle password visibility" onclick="togglePassword()">
            <svg id="eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <button type="submit">Authorize Connection</button>
      </form>
    </main>
    <script>
      function togglePassword() {
        var input = document.getElementById('owner_token');
        if (input.type === 'password') {
          input.type = 'text';
        } else {
          input.type = 'password';
        }
      }
    </script>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  const cleanRequested = requested.map((scope) => scope.trim()).filter(Boolean);
  if (cleanRequested.length === 0) return true;
  return cleanRequested.every((scope) => supported.includes(scope));
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.oauthStore = new SqliteOAuthStore(stateDir);
    this.clientsStore = new SqliteOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
  }

  isResourceAllowed(resource?: URL): boolean {
    if (!resource) return true;
    if (resource.origin !== this.resourceServerUrl.origin) return false;
    return (
      checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl }) ||
      checkResourceAllowed({ requestedResource: this.resourceServerUrl, configuredResource: resource }) ||
      resource.origin === this.resourceServerUrl.origin
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && !this.isResourceAllowed(params.resource)) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    const targetResource = resource ?? record.params.resource ?? this.resourceServerUrl;
    if (!this.isResourceAllowed(targetResource)) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    const cleanScopes = record.params.scopes?.map((s) => s.trim()).filter(Boolean);
    const scopes = cleanScopes && cleanScopes.length > 0 ? cleanScopes : this.config.scopes;
    return this.issueTokens(client.client_id, scopes, targetResource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const targetResource = resource ?? (record.resource ? new URL(record.resource) : this.resourceServerUrl);
    if (!this.isResourceAllowed(targetResource)) {
      throw new InvalidGrantError("Invalid resource");
    }

    const cleanRequestedScopes = scopes ? scopes.map((scope) => scope.trim()).filter(Boolean) : undefined;
    const effectiveScopes = cleanRequestedScopes && cleanRequestedScopes.length > 0 ? cleanRequestedScopes : record.scopes;
    if (!effectiveScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(
      client.client_id,
      effectiveScopes,
      targetResource,
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.oauthStore.close();
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;
    const resourceUrl = resource ?? this.resourceServerUrl;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resourceUrl.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resourceUrl.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  const cleanScopes = params.scopes?.map((s) => s.trim()).filter(Boolean);
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: cleanScopes && cleanScopes.length > 0 ? cleanScopes.join(" ") : undefined,
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

