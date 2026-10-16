import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

/**
 * The password component.
 *
 * Securely stores and verifies passwords, keyed only by an opaque `userId`. It
 * holds no email/username and knows nothing about the identity behind a user id
 * — intentionally reusable in any context. The app owns the users table and
 * maps its own identifiers onto the `userId` it passes in.
 *
 * Mounts the rate-limiter component to throttle `verifyPassword` per user id.
 */
const component = defineComponent("authPassword");
component.use(rateLimiter);

export default component;
