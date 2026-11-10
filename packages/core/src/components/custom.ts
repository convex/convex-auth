/**
 * Helpers for the components of sign-in methods: they attest users, and they
 * verify the attestations of the core and of the other components.
 *
 * A component calls {@link attestUser} when it verified a user, for example
 * when it checked a password. The core creates a session only from such an
 * attestation, thus the code of the app cannot sign a user in without a
 * component that verified the user.
 *
 * @internal Not public until third-party sign-in methods are supported.
 *
 * @module
 */
import type { MutationAuth } from "convex/server";
import { signAttestation, verifyAttestation } from "../lib/attestation.ts";
import {
  CURRENT_USER_ATTESTATION,
  NEW_USER_ATTESTATION,
  USER_ATTESTATION,
} from "../lib/attestationKinds.ts";
import { CORE_COMPONENT_PATH } from "../lib/coreComponent.ts";

/**
 * Attest that this component just verified the user `verifiedUserId`, for
 * example with a correct password.
 *
 * Call this function from a mutation of the component, and return the
 * attestation to the sign-in method. The sign-in method exchanges it for a
 * session in the same transaction (the attestation expires after one second).
 *
 * @internal
 */
export async function attestUser(
  ctx: { auth: Pick<MutationAuth, "signJwt"> },
  { verifiedUserId }: { verifiedUserId: string },
): Promise<string> {
  if (verifiedUserId === "") {
    throw new Error("Cannot attest a user with an empty ID.");
  }
  return await signAttestation(ctx, USER_ATTESTATION, {
    userId: verifiedUserId,
  });
}

/**
 * Verify a new-user attestation of the core and return the ID of the new
 * user.
 *
 * Call this function before the component connects its data to a new user.
 * It throws unless the core (the component at `auth`) signed the attestation.
 *
 * @internal
 */
export async function verifyNewUser(
  newUser: string,
): Promise<{ userId: string }> {
  const { componentPath, claims } = await verifyAttestation(
    NEW_USER_ATTESTATION,
    newUser,
  );
  if (componentPath !== CORE_COMPONENT_PATH) {
    throw new Error(
      `Invalid attestation: the core did not sign it (it came from "${componentPath}").`,
    );
  }
  return { userId: claims.userId };
}

/**
 * Verify a user attestation of any component and return the ID of the user
 * and the path of the component that verified the user.
 *
 * Call this function before the component changes the data of an existing
 * user, for example its password.
 *
 * @internal
 */
export async function verifyUser(
  attestation: string,
): Promise<{ userId: string; componentPath: string }> {
  const { componentPath, claims } = await verifyAttestation(
    USER_ATTESTATION,
    attestation,
  );
  return { userId: claims.userId, componentPath };
}

/**
 * Verify a current-user attestation of the core and return the ID of the
 * signed-in user.
 *
 * Call this function before the component changes the data of the signed-in
 * user, for example to add a passkey. It throws unless the core (the
 * component at `auth`) signed the attestation.
 *
 * @internal
 */
export async function verifyCurrentUser(
  currentUser: string,
): Promise<{ userId: string }> {
  const { componentPath, claims } = await verifyAttestation(
    CURRENT_USER_ATTESTATION,
    currentUser,
  );
  if (componentPath !== CORE_COMPONENT_PATH) {
    throw new Error(
      `Invalid attestation: the core did not sign it (it came from "${componentPath}").`,
    );
  }
  return { userId: claims.userId };
}
