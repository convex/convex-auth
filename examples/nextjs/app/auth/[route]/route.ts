import { auth } from "@/src/lib/serverAuth";

// One route for sign-in, refresh and sign-out: `auth.handler` picks the
// handler by the last path segment (/auth/signin, /auth/refresh,
// /auth/signout) and answers 404 to anything else.
//
// The sign-in handler serves every sign-in function listed in serverAuth.ts,
// forwarding each call to the deployment. Instead of sending all resulting
// tokens as part of the response body (as calling the Convex function directly
// would do), it moves the minted refresh token into an httpOnly cookie on the
// way back. Adding an auth method means adding its function to that allowlist.
// There is no per-method route or client code.
export const POST = auth.handler;
