/**
 * The kinds of attestations that Convex Auth uses. See `attestation.ts`.
 *
 * @module
 */
import * as z from "zod/mini";
import type { AttestationKind } from "./attestation.ts";

const userIdClaims = z.object({ userId: z.string().check(z.minLength(1)) });

/**
 * "This component just verified user `userId`." A component signs it, for
 * example after it checked a password. The core creates a session only from
 * an attestation of this kind, and components accept it to change the data of
 * that user.
 */
export const USER_ATTESTATION = {
  audience: "convex-auth/attestation/user",
  claims: userIdClaims,
} satisfies AttestationKind;

/**
 * "The core just created user `userId`." The core signs it in `createUser`.
 * Components accept it to connect their data to a new user, and only from the
 * core (`CORE_COMPONENT_PATH`).
 */
export const NEW_USER_ATTESTATION = {
  audience: "convex-auth/attestation/new-user",
  claims: userIdClaims,
} satisfies AttestationKind;

/**
 * "User `userId` is signed in to this request." The core signs it in
 * `attestCurrentUser`, from the identity of the request and the session of
 * its access token. Components accept it to change the data of the signed-in
 * user, and only from the core (`CORE_COMPONENT_PATH`). The core does not
 * create a session from it.
 */
export const CURRENT_USER_ATTESTATION = {
  audience: "convex-auth/attestation/current-user",
  claims: userIdClaims,
} satisfies AttestationKind;
