import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider, createAuthClient } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import App from "./App";
import "./index.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
const auth = createAuthClient({ convex, api: api.auth });

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ConvexAuthProvider auth={auth}>
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);
