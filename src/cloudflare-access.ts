import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { CloudflareAccessConfig } from "./config.js";

interface AccessClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}

interface AccessJwk {
  alg?: string;
  kid?: string;
  kty?: string;
  n: string;
  e: string;
  use?: string;
}

const MAX_ASSERTION_LENGTH = 16_384;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1_000;

/** Verify the JWT assertion Cloudflare Access adds to requests at the origin. */
export class CloudflareAccessVerifier {
  private keys = new Map<string, AccessJwk>();
  private keysExpireAt = 0;
  private refreshInFlight: Promise<void> | undefined;
  private readonly issuer: string;
  private readonly jwksUrl: URL;

  constructor(private readonly config: CloudflareAccessConfig) {
    this.issuer = `https://${config.teamDomain}`;
    this.jwksUrl = new URL("/cdn-cgi/access/certs", this.issuer);
  }

  async verify(assertion: string): Promise<AccessClaims | undefined> {
    if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return undefined;

    try {
      const [encodedHeader, encodedClaims, encodedSignature, extra] = assertion.split(".");
      if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) return undefined;

      const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
        alg?: string;
        kid?: string;
      };
      const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as AccessClaims;
      if (header.alg !== "RS256" || !header.kid) return undefined;
      if (claims.iss?.replace(/\/$/, "") !== this.issuer) return undefined;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(this.config.audience)) return undefined;

      const now = Date.now() / 1_000;
      if (typeof claims.exp !== "number" || claims.exp <= now) return undefined;
      if (typeof claims.nbf === "number" && claims.nbf > now + 30) return undefined;
      if (!claims.sub) return undefined;
      if (
        this.config.allowedEmail &&
        claims.email?.toLowerCase() !== this.config.allowedEmail.toLowerCase()
      ) {
        return undefined;
      }

      const jwk = await this.getKey(header.kid);
      if (!jwk) return undefined;
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      const valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
        publicKey,
        Buffer.from(encodedSignature, "base64url"),
      );
      return valid ? claims : undefined;
    } catch {
      return undefined;
    }
  }

  private async getKey(kid: string): Promise<AccessJwk | undefined> {
    if (Date.now() >= this.keysExpireAt || !this.keys.has(kid)) {
      if (!this.refreshInFlight) {
        this.refreshInFlight = this.refreshKeys().finally(() => {
          this.refreshInFlight = undefined;
        });
      }
      try {
        await this.refreshInFlight;
      } catch {
        return undefined;
      }
    }
    return this.keys.get(kid);
  }

  private async refreshKeys(): Promise<void> {
    const response = await fetch(this.jwksUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Cloudflare Access JWKS request failed: ${response.status}`);
    const document = await response.json() as { keys?: AccessJwk[] };
    this.keys = new Map(
      (document.keys ?? [])
        .filter((key) => key.kty === "RSA" && key.use !== "enc" && (!key.alg || key.alg === "RS256") && key.kid)
        .map((key) => [key.kid!, key]),
    );
    this.keysExpireAt = Date.now() + JWKS_CACHE_TTL_MS;
  }
}
