import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";
import passwordProvider from "@convex-dev/auth/components/password/convex.config.js";
import username from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp();

app.use(auth);
app.use(passwordProvider);
app.use(username);

export default app;
