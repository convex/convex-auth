use scrypt::password_hash::{Error, PasswordHash, PasswordVerifier};
use scrypt::{Params, Scrypt};
use wasm_bindgen::prelude::*;

// Limits for a stored scrypt hash. A hash is accepted only if one verification
// fits in the memory and time limits of a Convex mutation, next to the other
// code of the function.
//
// - Memory: scrypt uses 128 * r * (N + p) bytes. The parameters of Convex Auth
//   v1 (N = 2^14, r = 16, p = 1) use 32 MiB + 2 KiB.
// - Work: the time is about proportional to N * r * p. With the v1 parameters
//   (2^18), one verification takes about 65 ms. The limit is twice that work.
const MAX_MEMORY: u128 = 33 * 1024 * 1024;
const MAX_WORK: u128 = 1 << 19;
// scrypt requires N > 1.
const MIN_LOG_N: u8 = 1;

/// Parses a scrypt PHC string, `$scrypt$ln=<log2(N)>,r=<r>,p=<p>$<salt>$<hash>`,
/// and checks its parameters against the limits.
fn parse(phc: &str) -> Result<PasswordHash<'_>, String> {
    let hash = PasswordHash::new(phc).map_err(|e| e.to_string())?;
    if hash.algorithm.as_str() != "scrypt" {
        return Err(format!("unsupported algorithm `{}`", hash.algorithm));
    }
    // `Params::try_from` uses a default value for a missing parameter. The
    // defaults are larger than the limits, and a stored hash must not depend
    // on them: require each parameter.
    for name in ["ln", "r", "p"] {
        if hash.params.get(name).is_none() {
            return Err(format!("missing parameter `{name}`"));
        }
    }
    if hash.salt.is_none() || hash.hash.is_none() {
        return Err("missing salt or hash".to_string());
    }
    let params = Params::try_from(&hash).map_err(|e| e.to_string())?;
    let n = 1u128 << params.log_n();
    let r = u128::from(params.r());
    let p = u128::from(params.p());
    if params.log_n() < MIN_LOG_N || 128 * r * (n + p) > MAX_MEMORY || n * r * p > MAX_WORK {
        return Err("parameters out of the supported limits".to_string());
    }
    Ok(hash)
}

fn verify(password: &[u8], phc: &str) -> Result<bool, String> {
    let hash = parse(phc)?;
    match Scrypt.verify_password(password, &hash) {
        Ok(()) => Ok(true),
        Err(Error::Password) => Ok(false),
        // For example, a salt that is not valid B64: `PasswordHash` decodes
        // the salt only when it hashes.
        Err(e) => Err(e.to_string()),
    }
}

/// Verifies a password against a scrypt PHC string. The password is hashed as
/// given: the caller does the Unicode normalization, if any.
///
/// Returns an error if `phc` is not a valid scrypt PHC string or if its
/// parameters are out of the supported limits.
#[wasm_bindgen]
pub fn verify_password(password: &str, phc: &str) -> Result<bool, JsError> {
    verify(password.as_bytes(), phc).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `new Scrypt().hash("correct horse battery staple")` of lucia 3.2.0, as a
    // PHC string.
    const LUCIA: &str = "$scrypt$ln=14,r=16,p=1$YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU$O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug";
    // A valid salt and hash (64 bytes), for the parser tests.
    const SALT: &str = "YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU";
    const HASH: &str =
        "O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug";

    fn with_params(params: &str) -> String {
        format!("$scrypt${params}${SALT}${HASH}")
    }

    #[test]
    fn verifies_a_lucia_hash() {
        assert_eq!(verify(b"correct horse battery staple", LUCIA), Ok(true));
        assert_eq!(verify(b"wrong horse battery staple", LUCIA), Ok(false));
    }

    #[test]
    fn accepts_parameters_in_the_limits() {
        // The parameters of Convex Auth v1.
        assert!(parse(&with_params("ln=14,r=16,p=1")).is_ok());
        // The default of Node's `crypto.scrypt`: 16 MiB.
        assert!(parse(&with_params("ln=14,r=8,p=1")).is_ok());
        // Twice the work of v1.
        assert!(parse(&with_params("ln=14,r=16,p=2")).is_ok());
        assert!(parse(&with_params("ln=15,r=8,p=2")).is_ok());
        assert!(parse(&with_params("ln=1,r=1,p=1")).is_ok());
    }

    #[test]
    fn rejects_parameters_out_of_the_limits() {
        // 64 MiB of memory.
        assert!(parse(&with_params("ln=15,r=16,p=1")).is_err());
        // The default of passlib: 64 MiB of memory.
        assert!(parse(&with_params("ln=16,r=8,p=1")).is_err());
        // Three times the work of v1, with the same memory.
        assert!(parse(&with_params("ln=14,r=16,p=3")).is_err());
        // More work than the limit, with little memory.
        assert!(parse(&with_params("ln=10,r=8,p=128")).is_err());
        // Parameters that scrypt does not accept.
        assert!(parse(&with_params("ln=0,r=8,p=1")).is_err());
        assert!(parse(&with_params("ln=10,r=0,p=1")).is_err());
        assert!(parse(&with_params("ln=10,r=8,p=0")).is_err());
    }

    #[test]
    fn rejects_a_missing_parameter() {
        // Without `ln`, `Params::try_from` would use ln = 17 (128 MiB).
        assert!(parse(&with_params("r=8,p=1")).is_err());
        assert!(parse(&with_params("ln=10,p=1")).is_err());
        assert!(parse(&with_params("ln=10,r=8")).is_err());
    }

    #[test]
    fn rejects_malformed_strings() {
        for phc in [
            "",
            "not a hash",
            "$argon2id$v=19$m=16384,t=3,p=1$YzQwMzVkMTY1MzY3MDcw$O9VL85i/QsMazu72eTz7j2",
            &format!("$scrypt$ln=14,r=16,p=1${SALT}"),
            &format!("$scrypt$ln=14,r=16,p=1,x=1${SALT}${HASH}"),
            &format!("$scrypt$v=1$ln=14,r=16,p=1${SALT}${HASH}"),
            // Padding is not valid PHC B64.
            &format!("$scrypt$ln=14,r=16,p=1${SALT}=${HASH}"),
            // Not canonical: the last character has bits that are not zero.
            &format!("$scrypt$ln=14,r=16,p=1${}V${HASH}", &SALT[..SALT.len() - 1]),
            &format!("$scrypt$ln=14,r=16,p=1${SALT}${}h", &HASH[..HASH.len() - 1]),
        ] {
            assert!(verify(b"password", phc).is_err(), "accepted {phc:?}");
        }
    }
}
