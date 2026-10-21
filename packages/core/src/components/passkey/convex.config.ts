import { defineComponent } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

/**
 * The passkey (WebAuthn) component.
 *
 * The component owns the `passkeys` credential table and the short-lived
 * `challenges` table. It examines registrations and authentications on the
 * server. It stores credentials with an opaque `userId` only: the app owns
 * the users table.
 *
 * The component mounts the batch worker component. It runs the background
 * loop that erases the expired challenges (see cleanup.ts).
 *
 * The component has no configuration. The app passes the relying party ID
 * and the origin as arguments to the finish functions.
 */
const component = defineComponent("authPasskey");
component.use(batchWorker);

export default component;
