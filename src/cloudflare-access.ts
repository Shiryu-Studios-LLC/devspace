import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import * as z from "zod/v4";
import type { CloudflareAccessConfig } from "./config-schema.js";

export interface CloudflareAccessClaims extends JWTPayload {
  sub: string;
  email?: string;
  exp: number;
}

export interface CloudflareAccessVerifier {
  verify(assertion: string): Promise<CloudflareAccessClaims | undefined>;
}

const claimsSchema = z.object({
  sub: z.string().trim().min(1),
  email: z.email().optional(),
  exp: z.number().int().positive(),
}).passthrough();

const MAX_ASSERTION_LENGTH = 16_384;

export function createCloudflareAccessVerifier(
  config: CloudflareAccessConfig,
  keySet: JWTVerifyGetKey = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", `https://${config.teamDomain}`),
  ),
): CloudflareAccessVerifier {
  const issuer = `https://${config.teamDomain}`;

  return {
    async verify(assertion: string): Promise<CloudflareAccessClaims | undefined> {
      if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return undefined;

      try {
        const { payload } = await jwtVerify(assertion, keySet, {
          algorithms: ["RS256"],
          issuer,
          audience: config.audience,
        });

        const parsedClaims = claimsSchema.safeParse(payload);

        if (!parsedClaims.success) return undefined;

        const claims = parsedClaims.data;

        if (
          config.allowedEmail
          && (!claims.email || claims.email.toLowerCase() !== config.allowedEmail.toLowerCase())
        ) {
          return undefined;
        }

        return claims;
      } catch {
        return undefined;
      }
    },
  };
}
