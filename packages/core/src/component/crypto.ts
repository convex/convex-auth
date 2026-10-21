import { SignJWT, importPKCS8 } from "jose";

const ALG = "RS256";

/** Signs a JWT that Convex will accept as a custom-JWT identity. */
export async function signJwt(opts: {
  privateKeyPkcs8: string;
  kid: string;
  subject: string;
  issuer: string;
  audience: string;
  expiresInSeconds: number;
}): Promise<string> {
  const key = await importPKCS8(opts.privateKeyPkcs8, ALG);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + opts.expiresInSeconds;
  return await new SignJWT()
    .setProtectedHeader({ alg: ALG, kid: opts.kid, typ: "JWT" })
    .setSubject(opts.subject)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expSeconds)
    .sign(key);
}

/** Cryptographically random opaque refresh token. */
export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
