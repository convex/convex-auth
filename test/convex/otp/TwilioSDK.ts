"use node";

import { createAccount } from "@convex-dev/auth/server";
import { v } from "convex/values";
import twilio from "twilio";
import { internalAction } from "../_generated/server";

export const verify = internalAction({
  args: {
    phone: v.string(),
    code: v.optional(v.string()),
  },
  handler: async (ctx, { code, phone }) => {
    if (code === undefined) {
      await twilioVerify().verifications.create({
        to: phone,
        channel: "sms",
      });
      return null;
    }
    const { status } = await twilioVerify().verificationChecks.create({
      to: phone,
      code,
    });
    if (status !== "approved") {
      console.error(status);
      throw new Error("Code could not be verified");
    }
    const { account } = await createAccount(ctx, {
      provider: "twilio",
      account: {
        id: phone,
      },
      profile: {
        phone,
      },
      shouldLinkViaPhone: true,
    });
    return { userId: account.userId };
  },
});

export const message = internalAction({
  args: {
    from: v.string(),
    to: v.string(),
    code: v.optional(v.string()),
  },
  handler: async (_ctx, { code, from, to }) => {
    if (code === undefined) {
      throw new Error("Code is required");
    }
    await twilioClient().messages.create({
      from,
      to,
      body: `Sign in to MyApp. Your code is ${code}`,
    });
  },
});

function twilioVerify() {
  if (process.env.AUTH_TWILIO_SERVICE_SID === undefined) {
    throw new Error("Environment variable AUTH_TWILIO_SERVICE_SID is missing");
  }
  return twilioClient().verify.v2.services(process.env.AUTH_TWILIO_SERVICE_SID);
}

function twilioClient() {
  if (process.env.AUTH_TWILIO_ACCOUNT_SID === undefined) {
    throw new Error("Environment variable AUTH_TWILIO_ACCOUNT_SID is missing");
  }
  if (process.env.AUTH_TWILIO_AUTH_TOKEN === undefined) {
    throw new Error("Environment variable AUTH_TWILIO_AUTH_TOKEN is missing");
  }
  return twilio(
    process.env.AUTH_TWILIO_ACCOUNT_SID,
    process.env.AUTH_TWILIO_AUTH_TOKEN,
  );
}
