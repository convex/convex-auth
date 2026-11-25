import { auth } from "$lib/server/serverAuth";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request }) =>
  auth.refreshHandler(request);
