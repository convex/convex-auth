# react-email-code example

This demo shows:

- The core component.
- The email component, with the `emailCode` method: sign in, or sign up, with
  a code sent by email. There is no password.

## Generate code / run

Run the example from its own directory.

```bash
cd examples/react-email-code
npx convex dev --once    # provisions a deployment, generates convex/_generated
npx convex env set RESEND_API_KEY re_...   # your Resend API key
npx convex env set SENDER_EMAIL auth@example.com
npm run dev              # start the Vite frontend
```

The example sends real email through [Resend](https://resend.com).
`SENDER_EMAIL` is the From address of the emails. It must be on a
[domain you verified with Resend](https://resend.com/docs/dashboard/domains/introduction).
To try the example without a domain, use `onboarding@resend.dev`, which only
delivers to the email address of your own Resend account.

Optional environment variables on the deployment:

- `SENDER_NAME` — the From name of the emails. Defaults to `My App`.
