import type { TestConvex } from "convex-test";
import type { GenericMutationCtx, AnyDataModel } from "convex/server";
import {
  componentsGeneric,
  createFunctionHandle,
  type FunctionReference,
  type GenericSchema,
  type SchemaDefinition,
} from "convex/server";
import type { EmailSenderConfig } from "../components/email/validation.ts";
import schema from "./resendStub/schema.ts";
const modules = import.meta.glob("./resendStub/**/*.ts");

type T = TestConvex<SchemaDefinition<GenericSchema, boolean>>;

/**
 * Register a stub of the `@convex-dev/resend` component with a
 * `convex-test` instance.
 *
 * The stub records each email in its `emails` table instead of sending
 * it. Tests read the table with {@link sentEmails} to make assertions
 * about the sent emails.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerResendStub(t: T, name: string = "resend") {
  t.registerComponent(name, schema, modules);
}

/**
 * A sender config that points at the stub, for the `start` mutations of
 * the email component. Register the stub first.
 *
 * @param t - The test convex instance.
 * @param name - The name the stub was registered with.
 */
export async function stubEmailSender(
  t: T,
  name: string = "resend",
): Promise<EmailSenderConfig> {
  type StubApi = {
    lib: { sendEmail: FunctionReference<"mutation", "internal"> };
  };
  const stub = (componentsGeneric() as unknown as Record<string, StubApi>)[
    name
  ];
  const sendEmailHandle = await t.run(
    async () => await createFunctionHandle(stub.lib.sendEmail),
  );
  return {
    kind: "resend",
    sendEmailHandle,
    from: "Test App <auth@example.com>",
    apiKey: "re_test_key",
    initialBackoffMs: 0,
    retryAttempts: 0,
  };
}

/** One email that the stub recorded. */
export type SentEmail = {
  from: string;
  to: string[];
  subject?: string;
  html?: string;
  text?: string;
  headers?: { name: string; value: string }[];
};

/**
 * The emails that the stub recorded, oldest first.
 *
 * `convex-test` exposes `runInComponent` at runtime but does not declare
 * it, hence the cast.
 */
export function sentEmails(
  t: T,
  name: string = "resend",
): Promise<SentEmail[]> {
  const testApi = t as unknown as {
    runInComponent<Output>(
      componentPath: string,
      handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
    ): Promise<Output>;
  };
  return testApi.runInComponent(name, async (ctx) => {
    const rows = await ctx.db.query("emails").collect();
    return rows.map((row) => ({
      from: row.from as string,
      to: row.to as string[],
      subject: row.subject as string | undefined,
      html: row.html as string | undefined,
      text: row.text as string | undefined,
      headers: row.headers as { name: string; value: string }[] | undefined,
    }));
  });
}
export default {
  registerResendStub,
  stubEmailSender,
  sentEmails,
  schema,
  modules,
};
