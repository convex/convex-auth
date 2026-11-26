import type { Scenario } from "../scenario.ts";
import reactUsernamePassword from "./reactUsernamePassword.ts";

/** The scenarios that `--scenario` names; it also takes a path to a module. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  [reactUsernamePassword.name]: reactUsernamePassword,
};
