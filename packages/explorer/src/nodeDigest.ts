/**
 * The digests that a project config can name (see `SecretDigest`), with
 * `node:crypto`.
 *
 * @module
 */
import { createHash } from "node:crypto";
import type { DigestFunction } from "./secrets.ts";

export const nodeDigest: DigestFunction = (digest, value) => {
  switch (digest) {
    case "sha256Hex":
      return createHash("sha256").update(value, "utf8").digest("hex");
  }
};
