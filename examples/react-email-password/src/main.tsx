import { ConvexAuthProvider, createAuthClient } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { api } from "../convex/_generated/api";
import { App } from "./App";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
const auth = createAuthClient({ convex, api: api.auth });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider auth={auth}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexAuthProvider>
  </StrictMode>,
);
