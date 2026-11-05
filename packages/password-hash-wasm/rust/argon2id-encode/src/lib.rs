use argon2::password_hash::{Ident, Output, ParamsString, PasswordHash, SaltString};
use argon2::Params;
use wasm_bindgen::prelude::*;

/// Encodes argon2id parameters, a salt, and a derived key as a PHC string:
/// `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt>$<hash>`. It does not run argon2.
///
/// Use it to import the argon2id hashes of another system. Only version 0x13
/// (19) of argon2 is supported.
fn encode(m: u32, t: u32, p: u32, salt: &[u8], hash: &[u8]) -> Result<String, String> {
    let params = Params::new(m, t, p, Some(hash.len())).map_err(|e| e.to_string())?;
    let params = ParamsString::try_from(params).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(salt).map_err(|e| e.to_string())?;
    let hash = Output::new(hash).map_err(|e| e.to_string())?;
    Ok(PasswordHash {
        algorithm: Ident::new_unwrap("argon2id"),
        version: Some(19),
        params,
        salt: Some(salt.as_salt()),
        hash: Some(hash),
    }
    .to_string())
}

/// Encodes an argon2id hash as a PHC string. See `encode`.
#[wasm_bindgen]
pub fn encode_phc(m: u32, t: u32, p: u32, salt: &[u8], hash: &[u8]) -> Result<String, JsError> {
    encode(m, t, p, salt, hash).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{Algorithm, Argon2, PasswordHasher, Version};

    #[test]
    fn encodes_the_hash_of_argon2() {
        let params = Params::new(16 * 1024, 3, 1, None).unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let salt_bytes = [7u8; 16];
        let salt = SaltString::encode_b64(&salt_bytes).unwrap();
        let expected = argon2.hash_password(b"password", &salt).unwrap();

        let phc = encode(
            16 * 1024,
            3,
            1,
            &salt_bytes,
            expected.hash.unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(phc, expected.to_string());
    }

    #[test]
    fn rejects_invalid_values() {
        let salt = [7u8; 16];
        let key = [0u8; 32];
        // Parameters that argon2 does not accept.
        assert!(encode(7, 3, 1, &salt, &key).is_err());
        assert!(encode(16 * 1024, 0, 1, &salt, &key).is_err());
        assert!(encode(16 * 1024, 3, 0, &salt, &key).is_err());
        // A salt of more than 48 bytes (64 characters of B64).
        assert!(encode(16 * 1024, 3, 1, &[0; 49], &key).is_err());
        // A key of less than 10 bytes, or of more than 64 bytes.
        assert!(encode(16 * 1024, 3, 1, &salt, &key[..9]).is_err());
        assert!(encode(16 * 1024, 3, 1, &salt, &[0; 65]).is_err());
    }
}
