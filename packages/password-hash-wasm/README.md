# password-hash-wasm

> [!WARNING]
> This package exists for [Convex Auth](https://github.com/convex/convex-auth).
> Use outside of Convex Auth is not supported at the moment: the API can change at
> any time, and we can't help with other setups.

Password hashing for JavaScript. This is a thin wrapper around Rust crates,
compiled to WebAssembly with `wasm-bindgen`. Each entry point loads its own
WebAssembly module:

| Entry point                   | Rust crate                         |
| ----------------------------- | ---------------------------------- |
| `password-hash-wasm/argon2id` | [`argon2`](https://docs.rs/argon2) |

## `password-hash-wasm/argon2id`

```ts
import { hashPassword, verifyPassword } from "password-hash-wasm/argon2id";

const phc = await hashPassword("correct horse battery staple");
const ok = await verifyPassword("correct horse battery staple", phc);
```

`hashPassword` returns a PHC string with the salt and parameters embedded.

## Building

See [rust/README.md](https://github.com/convex/convex-auth/blob/reboot/packages/password-hash-wasm/rust/README.md)
to build the WASM bindings.
