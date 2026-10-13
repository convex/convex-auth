/**
 * The contract between the core client and ambient sign-ins.
 *
 * Ambient sign-ins run on their own at client startup, not because the app
 * called something. OAuth is the case today: the user comes back from Google
 * on some page that never called a sign-in hook, and the client has to notice
 * and finish it. They are registered whether the app uses them or not, so the
 * startup code has to return right away unless it finds a sign-in of its own
 * to finish.
 *
 * A method module exports a factory (e.g. `oauth(...)`) producing an
 * {@link AmbientSignInClient} the app passes to `ConvexAuthProvider`'s
 * `ambientSignIns` prop. Each registration carries a unique alphanumeric
 * `id` naming the auth method. The values and storage views the setup
 * receives are scoped by it, so two ambient sign-ins (or a sign-in and the
 * core token keys) can never collide. Setups run in two phases, both driven
 * by the `AuthClient`:
 *
 * 1. **Setup**: runs synchronously while the `AuthClient` is constructed.
 *    Register actions and set starting values in `ctx.values` here, so they
 *    exist before the app's first render reads them.
 * 2. **Init**: the optional returned `onInit` runs inside the client's
 *    `init()`, once per client instance, before the persisted session
 *    loads. Side-effectful work belongs here (e.g. handling an OAuth
 *    callback URL). Call `withSignInPending` synchronously in `onInit`
 *    around a sign-in completion, so the auth state reports loading rather
 *    than briefly signed out.
 *
 * `onInit` must gate its own work. A binding can register a setup the app
 * never asked for, so `onInit` should return right away unless it finds a
 * sign of its own flow, like a URL param or a storage key it wrote itself.
 *
 * The Convex imports are type-only. Like `SpaAuthApi`, this contract keeps
 * ambient sign-in logic free of any particular Convex client class, so
 * non-React bindings can drive the same setups.
 */
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { ClientView, SignInEnvelope } from "../lib/types.ts";
import type { SignInValues } from "./keyedStore.ts";
import type { AuthClient } from "./sessionManager.ts";
import type { SignInStorage } from "./storage.ts";

/**
 * A public function returning the shared `SignInEnvelope`, as the client sees
 * it. The requirement is on `_returnType` alone, leaving the args as Convex
 * declares them so its clients still infer optional args.
 */
export type SignInFunction<Type extends "mutation" | "action"> =
  FunctionReference<Type, "public"> & {
    _returnType: ClientView<SignInEnvelope>;
  };

/**
 * How the sign-in functions of a method get executed. Method code takes this
 * as given via {@link AmbientSignInContext} instead of picking a transport
 * itself. Executing the call is the only thing that differs between the two
 * session models, so one implementation of a method serves both:
 *
 *  - SPA: called against the deployment, returning the full `TokenBundle`
 *    for client JS to persist.
 *  - SSR: called through the auth proxy on the SSR host, returning an
 *    access-only `SlimTokenBundle` (the refresh token stays server-side).
 *
 * A method never sees which model it is running under.
 *
 * Only functions returning the shared `SignInEnvelope` are accepted, because
 * under SSR the auth proxy refuses any other result. A function that mints no
 * session goes through {@link ConvexMutationApi} instead.
 *
 * Sign-in functions are safe to run before authentication on any transport.
 * Callers retry them on network errors, so a sign-in function must tolerate
 * re-executing after an attempt that already committed server-side.
 */
export interface AuthSignInApi {
  mutation<F extends SignInFunction<"mutation">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  action<F extends SignInFunction<"action">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/**
 * How an ambient sign-in calls its public mutations that mint no session, like
 * starting an OAuth flow. These go straight to the deployment on either session
 * model, since there is no refresh token for the auth proxy to keep.
 */
export interface ConvexMutationApi {
  mutation<F extends FunctionReference<"mutation", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/** What an ambient sign-in's setup receives. */
export type AmbientSignInContext = {
  /** The core auth client the setup registers into. */
  client: AuthClient;
  /**
   * What this sign-in publishes for hooks to read, like its actions and the
   * status of the last attempt. Gone on reload.
   */
  values: SignInValues;
  /** Persistent storage for this sign-in. Survives a reload. */
  storage: SignInStorage;
  /**
   * Runs the sign-in functions of the method by reference. Only for functions
   * that return the shared sign-in envelope, because under SSR this is the
   * auth proxy, which refuses any other result.
   */
  signInApi: AuthSignInApi;
  /** Runs the other public mutations of the method by reference. */
  convex: ConvexMutationApi;
  /**
   * Replaces the page URL without navigating. Use this instead of
   * `history.replaceState` so a binding can keep its router in sync.
   */
  replaceUrl: (url: string) => void;
};

/**
 * An ambient sign-in's registration, passed via `ConvexAuthProvider`'s
 * `ambientSignIns` prop and run by the `AuthClient` while it is
 * constructed. See the module docs for the two-phase lifecycle.
 */
export type AmbientSignInClient = {
  /**
   * Unique name for the auth method (e.g. `"oauth"`). Alphanumeric only.
   * Scopes the sign-in's value and storage keys. Registering an invalid or
   * duplicate id throws.
   */
  id: string;
  /** The setup function. Runs while the `AuthClient` is constructed. */
  setup: (ctx: AmbientSignInContext) => void | { onInit?: () => void };
};
