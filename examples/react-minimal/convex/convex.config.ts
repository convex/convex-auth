import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";
import anonymous from "@convex-dev/auth/components/anonymous/convex.config.js";

const app = defineApp();

app.use(auth);
app.use(anonymous);

export default app;
