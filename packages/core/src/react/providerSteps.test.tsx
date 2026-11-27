// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../browser/sessionManager.ts";
import {
  CLIENT_STEP_REPORTS_GLOBAL,
  resetClientOpsForTests,
} from "../browser/steps.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { STEP_REPORT_PREFIX } from "../lib/stepFormat.ts";
import { AuthProvider } from "./client.tsx";
import { stubSignInApi } from "./testSignInApi.ts";

let consoleLines: string[] = [];

/** Each report as `[step, part, op, opKind, parentOp]`. */
function chain(): unknown[][] {
  return consoleLines
    .filter((line) => line.startsWith(STEP_REPORT_PREFIX))
    .map((line) => JSON.parse(line.slice(STEP_REPORT_PREFIX.length)))
    .map((r) => [r.step, r.part, r.op, r.opKind, r.parentOp]);
}

function newClient() {
  return new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: "http://127.0.0.1:3210",
  });
}

function provider(client: AuthClient, children: ReactNode = null) {
  return (
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      {children}
    </AuthProvider>
  );
}

const REACT = "module:react/client";
const SESSION = "module:browser/sessionManager";

beforeEach(() => {
  resetClientOpsForTests();
  consoleLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL];
  vi.restoreAllMocks();
});

describe("provider step reports", () => {
  test("report the mount as the parent of the start-up, and the unmount as the parent of the dispose", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const client = newClient();
    const view = render(provider(client));
    await waitFor(() => expect(client.getSnapshot().isLoading).toBe(false));
    view.unmount();

    const rows = chain();
    expect(rows.slice(0, 4)).toEqual([
      ["provider.mount", REACT, 1, "providerMount", undefined],
      ["crossTab.listen", SESSION, 2, "init", 1],
      ["init", SESSION, 2, "init", 1],
      ["state", SESSION, 2, "init", 1],
    ]);
    expect(rows.slice(-2)).toEqual([
      ["provider.unmount", REACT, 3, "providerUnmount", undefined],
      ["dispose", SESSION, 4, "dispose", 3],
    ]);
    expect(rows.filter(([step]) => step === "provider.mount")).toHaveLength(1);
  });

  test("report what StrictMode's mount, unmount, and mount again do", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const client = newClient();
    render(<StrictMode>{provider(client)}</StrictMode>);
    await waitFor(() => expect(client.getSnapshot().isLoading).toBe(false));

    const rows = chain().filter(
      ([step]) => !["storage.read", "state"].includes(step as string),
    );
    expect(rows).toEqual([
      ["provider.mount", REACT, 1, "providerMount", undefined],
      ["crossTab.listen", SESSION, 2, "init", 1],
      ["init", SESSION, 2, "init", 1],
      ["provider.unmount", REACT, 3, "providerUnmount", undefined],
      ["dispose", SESSION, 4, "dispose", 3],
      ["provider.mount", REACT, 5, "providerMount", undefined],
      // The second init() only re-attaches the cross-tab listener.
      ["crossTab.listen", SESSION, 6, "init", 5],
    ]);
  });

  test("write nothing and still start and dispose the client when the reports are off", async () => {
    const client = newClient();
    const init = vi.spyOn(client, "init");
    const dispose = vi.spyOn(client, "dispose");
    const view = render(provider(client));
    await waitFor(() => expect(client.getSnapshot().isLoading).toBe(false));
    act(() => view.unmount());
    expect(init).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(consoleLines).toEqual([]);
  });
});
