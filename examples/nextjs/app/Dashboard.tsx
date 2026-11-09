"use client";

import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { Preloaded, usePreloadedQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";

export function Dashboard({
  preloaded,
}: {
  preloaded: Preloaded<typeof api.users.loggedInUser>;
}) {
  const user = usePreloadedQuery(preloaded);
  const token = useAuthToken();
  const { signOut } = useAuthActions();
  const router = useRouter();

  return (
    <main style={{ padding: 24, maxWidth: 640 }}>
      <h1>Next.js SSR + Convex Auth</h1>
      <p>
        Signed in as <strong>{user?.name ?? "(loading)"}</strong> (user{" "}
        <code>{user?.id ?? "…"}</code>).
      </p>
      <p style={{ color: "#666" }}>
        Access token (JS-readable):{" "}
        <code>{token?.slice(0, 24) ?? "none"}…</code>
        <br />
        The refresh token is in an httpOnly cookie — it is never in JS.
      </p>
      <button
        onClick={async () => {
          await signOut();
          router.push("/signin");
        }}
      >
        Sign out
      </button>
    </main>
  );
}
