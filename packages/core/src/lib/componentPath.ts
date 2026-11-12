/**
 * The path of a component that the app mounts, from its reference.
 *
 * @module
 */
import { getFunctionAddress } from "convex/server";

/**
 * How Convex encodes the reference of a component that the app mounts:
 * `components.authPassword` is `_reference/childComponent/authPassword`.
 */
const CHILD_COMPONENT_PREFIX = "_reference/childComponent/";

/**
 * Get the path of a component from its reference, for example `"authPassword"`
 * from `components.authPassword`.
 *
 * Give the reference of a component that the app mounts (`app.use`). The
 * reference only tells that it points inside a mounted component, so this
 * function cannot refuse the reference of one of its functions:
 * `components.authPassword.public.signIn` gives `"authPassword/public/signIn"`.
 */
export function componentPathOf(component: object): string {
  let reference: string | undefined;
  try {
    reference = getFunctionAddress(component).reference;
  } catch {
    reference = undefined;
  }
  if (
    reference === undefined ||
    !reference.startsWith(CHILD_COMPONENT_PREFIX) ||
    reference.length === CHILD_COMPONENT_PREFIX.length
  ) {
    throw new Error(
      "Expected a reference inside a component that the app mounts, such " +
        "as `components.authPassword`.",
    );
  }
  return reference.slice(CHILD_COMPONENT_PREFIX.length);
}
