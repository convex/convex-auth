// @vitest-environment node
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { InMemoryStorage, JWT_STORAGE_KEY } from "../browser/storage.ts";
import {
  ConvexAuthProvider,
  createAuthClient,
  useAuthToken,
} from "./index.tsx";

const URL = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
  isAuthenticated: makeFunctionReference<"query">("auth:isAuthenticated"),
};

function Token() {
  return <span>{useAuthToken() ?? "no token"}</span>;
}

describe("ConvexAuthProvider on a server", () => {
  test("a shared auth client never holds a user's token", () => {
    // Apps can create the auth client once at module scope, so on a server
    // one client serves every request. Rendering with a user's token must
    // leave nothing in the client for the next request to see.
    const storage = new InMemoryStorage();
    const auth = createAuthClient({
      convex: new ConvexReactClient(URL),
      api: API,
      storage,
    });

    for (const token of ["access-user-1", "access-user-2"]) {
      const html = renderToString(
        <ConvexAuthProvider auth={auth} initialToken={token}>
          <Token />
        </ConvexAuthProvider>,
      );
      expect(html).toContain("no token");
      expect(auth.getAccessToken()).toBe(null);
      expect(auth.getSnapshot().token).toBe(null);
      expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(null);
    }
  });
});
