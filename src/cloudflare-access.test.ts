import assert from "node:assert/strict";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import type { CloudflareAccessConfig } from "./config-schema.js";
import { createCloudflareAccessVerifier } from "./cloudflare-access.js";

const config: CloudflareAccessConfig = {
  teamDomain: "shiryustudiosllc.cloudflareaccess.com",
  audience: "expected-access-audience",
  allowedEmail: "user@example.com",
};

async function localVerifier() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const verifier = createCloudflareAccessVerifier(config, createLocalJWKSet({ keys: [publicJwk] }));

  const sign = (claims: {
    issuer?: string;
    audience?: string;
    email?: string;
    expiration?: number | string;
    key?: CryptoKey;
  } = {}) => new SignJWT({ email: claims.email ?? config.allowedEmail })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(claims.issuer ?? `https://${config.teamDomain}`)
    .setAudience(claims.audience ?? config.audience)
    .setSubject("access-user-id")
    .setIssuedAt()
    .setExpirationTime(claims.expiration ?? "5m")
    .sign(claims.key ?? privateKey);

  return { verifier, sign };
}

test("Cloudflare verifier accepts a signed assertion with the configured issuer and audience", async () => {
  const { verifier, sign } = await localVerifier();

  await assert.doesNotReject(verifier.verify(await sign()));
});

test("Cloudflare verifier rejects invalid signatures, claims, expiry, and email", async () => {
  const { verifier, sign } = await localVerifier();
  const wrongPrivateKey = await generateKeyPair("RS256");

  await assert.equal(await verifier.verify(await sign({ issuer: "https://attacker.example" })), undefined);
  await assert.equal(await verifier.verify(await sign({ audience: "wrong-audience" })), undefined);
  await assert.equal(await verifier.verify(await sign({ key: wrongPrivateKey.privateKey })), undefined);
  await assert.equal(
    await verifier.verify(await sign({ expiration: Math.floor(Date.now() / 1000) - 1 })),
    undefined,
  );
  await assert.equal(await verifier.verify(await sign({ email: "other@example.com" })), undefined);
  await assert.equal(await verifier.verify("x".repeat(16_385)), undefined);
});
