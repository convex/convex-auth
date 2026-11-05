// TODO: Make the minimum length an option of each method (for example
// `setupUsernamePassword`). The password component then enforces only an
// absolute minimum of 8 characters. Today the component and all methods
// enforce 10.
/**
 * The minimum length of a new password in the password methods. The methods
 * export it (`@convex-dev/auth/methods/username-password`), so that a sign-up
 * form can show the same limit as the backend.
 *
 * Today it is equal to the minimum of the password component
 * (`MIN_PASSWORD_LENGTH` of `components/password/validation.ts`), which
 * `validateNewPassword` enforces.
 */
export const DEFAULT_MIN_PASSWORD_LENGTH = 10;
