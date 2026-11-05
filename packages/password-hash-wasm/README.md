# password-hash-wasm

> [!WARNING]
> This package exists for [Convex Auth](https://github.com/convex/convex-auth).
> Use outside of Convex Auth is not supported at the moment: the API can change at
> any time, and we can't help with other setups.

Password hashing for JavaScript. This is a thin wrapper around Rust crates,
compiled to WebAssembly with `wasm-bindgen`. Each entry point loads its own
WebAssembly module:

| Entry point                          | Rust crate                                             |
| ------------------------------------ | ------------------------------------------------------ |
| `password-hash-wasm/argon2id`        | [`argon2`](https://docs.rs/argon2)                     |
| `password-hash-wasm/argon2id-encode` | [`argon2`](https://docs.rs/argon2) (PHC encoding only) |
| `password-hash-wasm/scrypt`          | [`scrypt`](https://docs.rs/scrypt)                     |

## `password-hash-wasm/argon2id`

```ts
import { hashPassword, verifyPassword } from "password-hash-wasm/argon2id";

const phc = await hashPassword("correct horse battery staple");
const ok = await verifyPassword("correct horse battery staple", phc);
```

`hashPassword` returns a PHC string with the salt and parameters embedded.

## `password-hash-wasm/argon2id-encode`

```ts
import { encodePHC } from "password-hash-wasm/argon2id-encode";

const phc = await encodePHC({ m: 16384, t: 3, p: 1, salt, hash });
```

`encodePHC` encodes the argon2id parameters, the salt, and the derived key of a
hash from another system as a PHC string. It does not run argon2, so its module
is small. Use it to import hashes, for example in a migration.

## `password-hash-wasm/scrypt`

```ts
import { verifyPassword } from "password-hash-wasm/scrypt";

const ok = await verifyPassword(
  "correct horse battery staple",
  "$scrypt$ln=14,r=16,p=1$<salt>$<hash>",
);
```

`verifyPassword` verifies a password against a scrypt PHC string. The package
does not make scrypt hashes. The password is hashed as given: normalize it
before the call if the hash was made from a normalized password. The
parameters must be in limits that keep one verification inside the memory and
time limits of a Convex mutation (see the doc comment of `verifyPassword`).

## `password-hash-wasm/scrypt-encode`

```ts
import { encodePHC } from "password-hash-wasm/scrypt-encode";

const phc = await encodePHC({ ln: 14, r: 16, p: 1, salt, hash });
```

`encodePHC` encodes the scrypt parameters, the salt, and the derived key of a
hash from another system as a PHC string. It does not run scrypt, so its
module is small. Use it to import hashes, for example in a migration.

## Building

See [rust/README.md](https://github.com/convex/convex-auth/blob/reboot/packages/password-hash-wasm/rust/README.md)
to build the WASM bindings.
