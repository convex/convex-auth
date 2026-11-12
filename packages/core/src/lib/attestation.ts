/**
 * Attestations: short-lived JWTs that a component signs with the deployment's
 * key to state a fact, for example "this component verified user X".
 *
 * The code of the app passes attestations between components, but it cannot
 * make one: only a component can sign a token with a component issuer
 * (`${CONVEX_CLOUD_URL}/components/<path>`). Thus a component that receives an
 * attestation knows which component made the statement.
 *
 * Each kind of attestation has its own audience, thus a token of one kind is
 * never accepted as a token of a different kind.
 *
 * An attestation expires after one second, and the verification has no clock
 * tolerance. Use an attestation in the same transaction that made it.
 *
 * Signing and verification are separate functions, thus a module that only
 * signs does not include the verification code.
 *
 * @module
 */
import type { MutationAuth, SignJwtClaims } from "convex/server";
import * as z from "zod/mini";
import { componentPathFromIssuer } from "./coreComponent.ts";

/**
 * A kind of attestation: its audience and the schema of its claims.
 *
 * Declare each kind once, as a constant, and give the same constant to
 * {@link signAttestation} and {@link verifyAttestation}.
 *
 * The claims must not use the names of the registered claims (`aud`, `iss`,
 * `iat`, `exp`, `jti`, `sub`, `nbf`) or names that start with `convex` or
 * `cvx`.
 */
export type AttestationKind<Claims extends z.ZodMiniType = z.ZodMiniType> = {
  /** The `aud` claim. Each kind must have a different audience. */
  audience: string;
  /** The schema of the claims that the kind adds to the token. */
  claims: Claims;
};

/** The lifetime of an attestation, in seconds. */
export const ATTESTATION_TTL_SECONDS = 1;

/** The `ctx` of a mutation, or the part of it that signing needs. */
type SigningCtx = { auth: Pick<MutationAuth, "signJwt"> };

/**
 * Sign an attestation of the given kind with the deployment's key.
 *
 * Call this function from a mutation of a component. The deployment sets the
 * issuer to the path of the component that calls it.
 */
export async function signAttestation<Claims extends z.ZodMiniType>(
  ctx: SigningCtx,
  kind: AttestationKind<Claims>,
  claims: z.input<Claims>,
): Promise<string> {
  const encoded = z.encode(kind.claims, claims as z.output<Claims>);
  if (
    typeof encoded !== "object" ||
    encoded === null ||
    Array.isArray(encoded)
  ) {
    throw new Error("The claims of an attestation must be an object.");
  }
  return await ctx.auth.signJwt({
    claims: { ...encoded, aud: kind.audience } as SignJwtClaims,
    expiresInSeconds: ATTESTATION_TTL_SECONDS,
  });
}

/** The result of {@link verifyAttestation}. */
export type VerifiedAttestation<Claims extends z.ZodMiniType> = {
  /**
   * The path of the component that signed the attestation, for example
   * `"authPassword"`.
   */
  componentPath: string;
  /** The claims of the attestation, decoded with the schema of its kind. */
  claims: z.output<Claims>;
};

/**
 * Verify an attestation of the given kind and return the path of the
 * component that signed it, and its claims.
 *
 * The function throws when the token is not a valid attestation of this kind:
 * a bad signature, a different audience, an expired token, an issuer that is
 * not a component of this deployment, or claims that do not match the schema.
 */
export async function verifyAttestation<Claims extends z.ZodMiniType>(
  kind: AttestationKind<Claims>,
  token: string,
): Promise<VerifiedAttestation<Claims>> {
  const payload = await verifyDeploymentJwt(token);

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(kind.audience)) {
    throw invalid(`the audience is not ${JSON.stringify(kind.audience)}`);
  }

  // No clock tolerance. In a mutation, `Date.now()` does not change, thus an
  // attestation that the same transaction made is always in this window.
  const now = Date.now() / 1000;
  if (typeof payload.exp !== "number" || now >= payload.exp) {
    throw invalid("it expired");
  }
  if (typeof payload.iat !== "number" || payload.iat > now) {
    throw invalid("it was issued in the future");
  }

  const componentPath = componentPathFromIssuer(payload.iss);
  if (componentPath === null) {
    throw invalid("a component of this deployment did not sign it");
  }

  const parsed = z.safeDecode(kind.claims, payload as z.input<Claims>);
  if (!parsed.success) {
    throw invalid("its claims do not match the schema of its kind");
  }
  return { componentPath, claims: parsed.data };
}

function invalid(reason: string): Error {
  return new Error(`Invalid attestation: ${reason}.`);
}

// --- ES256 verification with WebCrypto --------------------------------------

type DeploymentJwk = {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
};

/**
 * Verify the ES256 signature of a JWT against the deployment's public keys
 * and return its payload. This function does not check the claims.
 */
async function verifyDeploymentJwt(
  token: string,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw invalid("it is not a JWT");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = parseJsonObject(encodedHeader);
  const payload = parseJsonObject(encodedPayload);
  if (header === null || payload === null) {
    throw invalid("it is not a JWT");
  }
  if (header.alg !== "ES256") {
    throw invalid("its algorithm is not ES256");
  }

  const { keys } = await getDeploymentJwks();
  const jwk = keys.find(
    (key) =>
      key.kid === header.kid &&
      key.kty === "EC" &&
      key.crv === "P-256" &&
      (key.alg === undefined || key.alg === "ES256"),
  );
  if (jwk === undefined) {
    throw invalid("no deployment key has its key ID");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) {
    throw invalid("its signature is not valid");
  }
  return payload;
}

/**
 * The public keys of the deployment, the same keys that the deployment serves
 * at `${CONVEX_CLOUD_URL}/.well-known/jwks.json`.
 */
async function getDeploymentJwks(): Promise<{ keys: DeploymentJwk[] }> {
  const convex = (
    globalThis as {
      Convex?: { asyncSyscall?: (op: string, args: string) => Promise<string> };
    }
  ).Convex;
  if (convex?.asyncSyscall === undefined) {
    throw new Error(
      "Attestations can only be verified inside a Convex function.",
    );
  }
  return JSON.parse(await convex.asyncSyscall("1.0/getDeploymentJwks", "{}"));
}

function parseJsonObject(encoded: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(encoded: string): Uint8Array<ArrayBuffer> {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
