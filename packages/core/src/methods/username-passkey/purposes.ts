/** The re-authentication that signs a user in. */
export const SIGN_IN_PURPOSE = "usernamePasskey:signIn";

/** The re-authentication that comes before a user adds a passkey. */
export const ADD_PASSKEY_PURPOSE = "usernamePasskey:addPasskey";

/** The re-authentication that authorizes the removal of a passkey. */
export const REMOVE_PASSKEY_PURPOSE = "usernamePasskey:removePasskey";

/**
 * The re-authentication that records a new authentication of the current
 * session, before a sensitive action.
 */
export const REAUTHENTICATE_PURPOSE = "usernamePasskey:reauthenticate";
