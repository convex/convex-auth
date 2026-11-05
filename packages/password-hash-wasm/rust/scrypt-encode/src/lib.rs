use scrypt::password_hash::{Ident, Output, ParamsString, PasswordHash, SaltString};
use scrypt::Params;
use wasm_bindgen::prelude::*;

/// Encodes scrypt parameters, a salt, and a derived key as a PHC string:
/// `$scrypt$ln=<log_n>,r=<r>,p=<p>$<salt>$<hash>`. It does not run scrypt.
///
/// Use it to import the scrypt hashes of another system. For example, a hash
/// of lucia `Scrypt` is `<salt>:<hex key>`: its salt is the UTF-8 bytes of
/// `<salt>`, its key is the decoded `<hex key>`, and `log_n = 14`, `r = 16`,
/// `p = 1`.
fn encode(log_n: u8, r: u32, p: u32, salt: &[u8], hash: &[u8]) -> Result<String, String> {
    let params = Params::new(log_n, r, p, hash.len()).map_err(|e| e.to_string())?;
    let params = ParamsString::try_from(params).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(salt).map_err(|e| e.to_string())?;
    let hash = Output::new(hash).map_err(|e| e.to_string())?;
    Ok(PasswordHash {
        algorithm: Ident::new_unwrap("scrypt"),
        version: None,
        params,
        salt: Some(salt.as_salt()),
        hash: Some(hash),
    }
    .to_string())
}

/// Encodes a scrypt hash as a PHC string. See `encode`.
#[wasm_bindgen]
pub fn encode_phc(log_n: u8, r: u32, p: u32, salt: &[u8], hash: &[u8]) -> Result<String, JsError> {
    encode(log_n, r, p, salt, hash).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    // `new Scrypt().hash("correct horse battery staple")` of lucia 3.2.0.
    const LUCIA_SALT: &str = "c4035d165367070061094d44d4c85d35";
    const LUCIA_KEY: &str = "3bd54bf398bf42c31aceeef6793cfb8f6b8e7b64ab3ea3f745b96e3dd380ce24f51b0db14a8ed8360f4227d42ccbe9d2ad227b49fb2fec4ac100806debe37eba";
    const PHC: &str = "$scrypt$ln=14,r=16,p=1$YzQwMzVkMTY1MzY3MDcwMDYxMDk0ZDQ0ZDRjODVkMzU$O9VL85i/QsMazu72eTz7j2uOe2SrPqP3RbluPdOAziT1Gw2xSo7YNg9CJ9Qsy+nSrSJ7Sfsv7ErBAIBt6+N+ug";

    fn decode_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn encodes_a_lucia_hash() {
        let phc = encode(14, 16, 1, LUCIA_SALT.as_bytes(), &decode_hex(LUCIA_KEY)).unwrap();
        assert_eq!(phc, PHC);
    }

    #[test]
    fn rejects_invalid_values() {
        let salt = LUCIA_SALT.as_bytes();
        let key = decode_hex(LUCIA_KEY);
        // Parameters that scrypt does not accept.
        assert!(encode(14, 0, 1, salt, &key).is_err());
        assert!(encode(14, 16, 0, salt, &key).is_err());
        // A salt of more than 48 bytes (64 characters of B64).
        assert!(encode(14, 16, 1, &[0; 49], &key).is_err());
        // A key of less than 10 bytes, or of more than 64 bytes.
        assert!(encode(14, 16, 1, salt, &key[..9]).is_err());
        assert!(encode(14, 16, 1, salt, &[0; 65]).is_err());
    }
}
