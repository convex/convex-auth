import schema from "./schema.ts";
import { testProviderFunctionsContract } from "../../lib/oauth/componentContract.fixture.ts";

/**
 * Google's component keeps the shared tables and registers the shared
 * mutations over them, so the shared contract is the whole of what its
 * `provider.ts` owes the app side.
 */
const modules = import.meta.glob("./**/*.ts");

testProviderFunctionsContract(schema, modules);
