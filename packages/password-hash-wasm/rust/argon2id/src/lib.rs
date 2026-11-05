use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use wasm_bindgen::prelude::*;

// Argon2id parameters per https://auth.pilcrowonpaper.com/passwords:
// 16 MiB memory, 3 iterations, 1 degree of parallelism.
fn argon2() -> Result<Argon2<'static>, JsError> {
    let params = Params::new(16 * 1024, 3, 1, None).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

#[wasm_bindgen]
pub fn hash_password(password: &str, salt: &[u8]) -> Result<String, JsError> {
    let salt = SaltString::encode_b64(salt).map_err(|e| JsError::new(&e.to_string()))?;
    let hash = argon2()?
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(hash.to_string()) // PHC string
}

#[wasm_bindgen]
pub fn verify_password(password: &str, phc: &str) -> Result<bool, JsError> {
    let parsed = PasswordHash::new(phc).map_err(|e| JsError::new(&e.to_string()))?;
    // Verification reads the algorithm and parameters from the stored PHC
    // string, so it accepts any hash we previously produced.
    Ok(argon2()?
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}
