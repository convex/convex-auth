import { auth } from "@/src/lib/serverAuth";

// One route for sign-in, refresh and sign-out.
export const POST = auth.handler;
