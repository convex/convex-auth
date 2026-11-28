// Hooks for the explorer (`packages/explorer`), which records this app to show
// Convex Auth running. Both stay inert unless the page sets the global
// `__CONVEX_AUTH_EXPLORER_STORAGE__` before the app loads; a normal page load
// never sets it. Not part of the example to copy.
import type { TokenStorage } from "@convex-dev/auth/browser";
import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react";
import { useEffect } from "react";
import { api } from "../convex/_generated/api";

type ExplorerStorageOptions = { delayMs: number };

function explorerOptions(): ExplorerStorageOptions | null {
  const options = (globalThis as Record<string, unknown>)
    .__CONVEX_AUTH_EXPLORER_STORAGE__ as ExplorerStorageOptions | undefined;
  return typeof options?.delayMs === "number" ? options : null;
}

/**
 * Slow storage, as on React Native: `localStorage` behind an async
 * `TokenStorage` whose every call answers after `delayMs`. A read returns the
 * value stored when it was made, like a request already in flight. Undefined
 * unless the explorer asked for it, so the provider keeps its default.
 */
export function explorerStorage(): TokenStorage | undefined {
  const options = explorerOptions();
  if (options === null) return undefined;
  const later = <T,>(value: T) =>
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(value), options.delayMs),
    );
  return {
    getItem: (key) => later(window.localStorage.getItem(key)),
    setItem: (key, value) => later(window.localStorage.setItem(key, value)),
    removeItem: (key) => later(window.localStorage.removeItem(key)),
  };
}

declare global {
  interface Window {
    __CONVEX_AUTH_EXPLORER_SIGN_IN__?: (
      username: string,
      password: string,
    ) => Promise<string>;
  }
}

/**
 * Lets the explorer sign in while the page still shows "Loading…", when the
 * form is not on screen: it calls the same public hook as the form. Renders
 * nothing, and does nothing unless the explorer asked for slow storage.
 */
export function ExplorerSignIn() {
  const { signIn } = useSignInWithUsernamePassword(api.auth);
  useEffect(() => {
    if (explorerOptions() === null) return;
    window.__CONVEX_AUTH_EXPLORER_SIGN_IN__ = async (username, password) =>
      (await signIn({ username, password })).status;
    return () => {
      delete window.__CONVEX_AUTH_EXPLORER_SIGN_IN__;
    };
  }, [signIn]);
  return null;
}
