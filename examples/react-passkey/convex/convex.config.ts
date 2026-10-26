import { defineApp } from "convex/server";
import core from "@convex-dev/auth/convex.config.js";
import passkey from "@convex-dev/auth/components/passkey/convex.config.js";
import username from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp();

app.use(core);
app.use(passkey);
app.use(username);

export default app;
