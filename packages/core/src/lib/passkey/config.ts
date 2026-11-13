/**
 * What the shared passkey code needs from a passkey method.
 *
 * @module
 */
import type { ComponentApi } from "../../components/passkey/_generated/component.ts";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import type { ExpectedOrigin } from "../../components/passkey/validation.ts";

/**
 * The settings of a passkey method that the shared passkey code reads. The
 * declarations of the public functions that this code makes refer to it, so
 * the published types keep it.
 */
export type PasskeyConfig = {
  /** The passkey component. */
  component: ComponentApi;
  /** The core component. */
  coreComponent: CoreComponentApi;
  /** The relying party ID: the domain that the passkeys belong to. */
  rpId: string;
  /** The name of the relying party, which the browser shows. */
  rpName: string;
  /** The origins that a ceremony may come from. */
  origin: ExpectedOrigin;
};
