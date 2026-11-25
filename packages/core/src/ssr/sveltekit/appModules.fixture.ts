/**
 * Stand-ins for the `$app/environment` and `$app/navigation` modules that
 * SvelteKit provides to an app, for the tests of the SvelteKit bindings. The
 * Vitest config of the repository aliases both to this module.
 *
 * @module
 */

import { vi } from "vitest";

export const dev = false;
export const invalidateAll = vi.fn(async () => {});
export const replaceState = vi.fn();
