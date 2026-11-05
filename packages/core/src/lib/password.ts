// TODO: Make the minimum length an option of each method (for example
// `setupUsernamePassword`). Today all methods enforce 10.
/**
 * The minimum length of a new password in the password methods. The methods
 * export it (`@convex-dev/auth/methods/username-password`), so that a sign-up
 * form can show the same limit as the backend.
 *
 * The password component accepts shorter passwords (`MIN_PASSWORD_LENGTH` of
 * `components/password/validation.ts`). Thus the methods give this value to
 * `validateNewPassword`.
 */
export const DEFAULT_MIN_PASSWORD_LENGTH = 10;
