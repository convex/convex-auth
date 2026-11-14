import { defineSchema } from "convex/server";
import {
  accountsTable,
  authorizationRequestsTable,
  ticketsTable,
} from "../../lib/oauth/schema.ts";

export default defineSchema({
  authorizationRequests: authorizationRequestsTable,
  tickets: ticketsTable,
  accounts: accountsTable,
});
