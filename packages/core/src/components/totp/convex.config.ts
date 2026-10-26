/**
 * The TOTP component.
 *
 * @internal Not public until the API of the TOTP component is stable.
 * @module
 */
import { defineComponent } from "convex/server";

/**
 * The TOTP component.
 *
 * Stores and verifies time-based one-time password secrets (RFC 6238) and
 * their backup codes, keyed only by an opaque `userId`. The component knows
 * nothing about the identity behind a user id: the app owns the users table
 * and maps its own identifiers onto the `userId` it passes in.
 *
 * The component is not an auth provider. It is a second factor that an auth
 * flow asks to verify a code after the first factor succeeds.
 */
const component = defineComponent("authTotp");

export default component;
