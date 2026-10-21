/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    challenge: {
      addEmail: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | { error: "EMAIL_TAKEN" }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          { browserSecret: string; emailCode: string; userId: string },
          | { email: string; success: true; userId: string }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "EMAIL_TAKEN" }
                | { error: "WRONG_USER" };
            },
          Name
        >;
        start: FunctionReference<
          "mutation",
          "internal",
          {
            email: string;
            emailSender: {
              apiKey: string;
              from: string;
              initialBackoffMs: number;
              kind: "resend";
              retryAttempts: number;
              sendEmailHandle: string;
            };
            url: string;
            userId: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
      };
      changeEmail: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | { error: "EMAIL_TAKEN" }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          { browserSecret: string; emailCode: string; userId: string },
          | {
              email: string;
              previousEmail: string | null;
              success: true;
              userId: string;
            }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "EMAIL_TAKEN" }
                | { error: "WRONG_USER" };
            },
          Name
        >;
        start: FunctionReference<
          "mutation",
          "internal",
          {
            email: string;
            emailSender: {
              apiKey: string;
              from: string;
              initialBackoffMs: number;
              kind: "resend";
              retryAttempts: number;
              sendEmailHandle: string;
            };
            url: string;
            userId: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
      };
      custom: {
        cancelForUser: FunctionReference<
          "mutation",
          "internal",
          { purpose: string; userId: string },
          null,
          Name
        >;
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          {
            browserSecret: string;
            currentUserId: string | null;
            emailCode: string;
            purpose: string;
          },
          | { email: string; emailOwnerId: string | null; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "WRONG_USER" };
            },
          Name
        >;
        peek: FunctionReference<
          "query",
          "internal",
          {
            browserSecret: string;
            currentUserId: string | null;
            emailCode: string;
            purpose: string;
          },
          | { email: string; emailOwnerId: string | null; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "WRONG_USER" };
            },
          Name
        >;
        start: FunctionReference<
          "mutation",
          "internal",
          {
            email: string;
            emailSender: {
              apiKey: string;
              from: string;
              initialBackoffMs: number;
              kind: "resend";
              retryAttempts: number;
              sendEmailHandle: string;
            };
            expectedUserId: string | null;
            intro: string;
            purpose: string;
            subject: string;
            ttlMs?: number;
            url: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number };
            },
          Name
        >;
      };
      signUp: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | { error: "EMAIL_TAKEN" }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          { browserSecret: string; emailCode: string },
          | { email: string; success: true; userId: string }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
        start: FunctionReference<
          "mutation",
          "internal",
          {
            email: string;
            emailSender: {
              apiKey: string;
              from: string;
              initialBackoffMs: number;
              kind: "resend";
              retryAttempts: number;
              sendEmailHandle: string;
            };
            url: string;
            userId: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
      };
    };
    verifiedEmails: {
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      getEmails: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{ email: string; isPrimary: boolean }>,
        Name
      >;
      getPrimaryEmail: FunctionReference<
        "query",
        "internal",
        { userId: string },
        string | null,
        Name
      >;
      lookupEmail: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        | { storedEmail: string; success: true; userId: string }
        | {
            success: false;
            userError:
              | { error: "EMAIL_NOT_FOUND" }
              | { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
    };
  };
