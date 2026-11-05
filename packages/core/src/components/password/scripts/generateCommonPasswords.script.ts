/**
 * Generator for `commonPasswords.generated.ts`.
 *
 * Run this script with Bun from the `packages/core` directory:
 *
 *     bun run generate:common-passwords
 *
 * The script does these steps:
 *  1. It makes a clone of the SecLists repository in a temporary directory.
 *     The clone gets only one file, because a full clone is approximately 1 GB.
 *  2. It reads the password list. The list is in order of frequency.
 *  3. It keeps the most frequent passwords that are long enough (see
 *     `METHOD_PASSWORD_COUNT`).
 *  4. It writes the generated TypeScript file.
 *  5. It removes the temporary directory.
 *
 * The file name contains two dots. Thus the Convex bundler does not use this
 * file as a function module of the password component.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SECLISTS_REPOSITORY = "https://github.com/danielmiessler/SecLists.git";

/**
 * The source list. It comes from the UK National Cyber Security Centre (NCSC)
 * and from Have I Been Pwned. The passwords are in order of frequency for the
 * full length of the file.
 *
 * Do not replace this list with `xato-net-10-million-passwords-1000000.txt`.
 * Only the first 5000 lines of that file are in order of frequency. The
 * remainder is in alphabetical order.
 */
const SOURCE_PATH =
  "Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt";

/**
 * The minimum length of a password in the generated list. It is less than the
 * minimum length of the component (`MIN_PASSWORD_LENGTH`), so that the list is
 * ready for a component minimum of 8 characters. Passwords that are shorter
 * than 8 characters are not necessary in the list.
 *
 * TODO(nicolas) Support more than one minimum length. Applications that use a
 * different minimum length need a different list. Note that the source list
 * contains only 357 distinct passwords with 15 characters or more.
 */
const MIN_LENGTH = 8;

/**
 * The minimum length of a new password in the password methods
 * (`DEFAULT_MIN_PASSWORD_LENGTH`).
 */
const METHOD_MIN_LENGTH = 10;

/**
 * The quantity of passwords with {@link METHOD_MIN_LENGTH} characters or more to
 * put in the generated list. The list also contains all the passwords of
 * {@link MIN_LENGTH} characters or more that are more frequent than the last
 * of these passwords. Thus the password methods get the same protection as with
 * a list of these passwords only.
 */
const METHOD_PASSWORD_COUNT = 3000;

const OUTPUT_PATH = fileURLToPath(
  new URL("../commonPasswords.generated.ts", import.meta.url),
);

main();

function main(): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "seclists-"));
  try {
    const sourceText = cloneAndRead(temporaryDirectory);
    const passwords = selectPasswords(sourceText);
    writeFileSync(OUTPUT_PATH, renderGeneratedFile(passwords), "utf8");
    console.log(`Wrote ${passwords.length} passwords to ${OUTPUT_PATH}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Get the source list. Return its contents. */
function cloneAndRead(temporaryDirectory: string): string {
  const clonePath = join(temporaryDirectory, "SecLists");

  // `--filter=blob:none` prevents the download of the file contents.
  // `--sparse` prevents the checkout of all the directories.
  // Together with the `sparse-checkout` command below, git downloads only the
  // one file that this script reads.
  run("git", [
    "clone",
    "--depth=1",
    "--filter=blob:none",
    "--sparse",
    SECLISTS_REPOSITORY,
    clonePath,
  ]);
  // `--no-cone` is necessary, because the pattern is a file and not a
  // directory.
  run("git", [
    "-C",
    clonePath,
    "sparse-checkout",
    "set",
    "--no-cone",
    `/${SOURCE_PATH}`,
  ]);

  return readFileSync(join(clonePath, SOURCE_PATH), "utf8");
}

function run(command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit" });
}

/**
 * Select the most frequent passwords that are applicable. The result keeps the
 * order of the source list. Thus the first item is the most frequent password.
 *
 * Each password is put in the same form as in `commonPasswords.ts`: the script
 * applies the NFC normalization and then makes the password lowercase. The
 * result contains no duplicates in that form.
 */
function selectPasswords(sourceText: string): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  let methodPasswordCount = 0;

  for (const line of sourceText.split("\n")) {
    const password = line.replace(/\r$/, "");
    if (password === "") {
      continue;
    }
    // Make the password lowercase after the normalization, in the same
    // sequence as `normalizeForLookup` in `commonPasswords.ts`.
    const normalized = password.normalize("NFC").toLowerCase();
    // Measure the length in Unicode code points, in the same way as
    // `validatePasswordInputFormat`. The lowercase operation can change the
    // length. Thus this test comes after that operation.
    if ([...normalized].length < MIN_LENGTH) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    selected.push(normalized);
    if ([...normalized].length >= METHOD_MIN_LENGTH) {
      methodPasswordCount++;
      if (methodPasswordCount === METHOD_PASSWORD_COUNT) {
        break;
      }
    }
  }

  if (methodPasswordCount < METHOD_PASSWORD_COUNT) {
    throw new Error(
      `The source list contains only ${methodPasswordCount} passwords with ` +
        `${METHOD_MIN_LENGTH} characters or more, but ${METHOD_PASSWORD_COUNT} ` +
        `are necessary.`,
    );
  }
  return selected;
}

/** Write the TypeScript source of the generated file. */
function renderGeneratedFile(passwords: string[]): string {
  const byLength = new Map<number, string[]>();
  for (const password of passwords) {
    const length = [...password].length;
    const bucket = byLength.get(length);
    if (bucket === undefined) {
      byLength.set(length, [password]);
    } else {
      bucket.push(password);
    }
  }

  const lengths = [...byLength.keys()].sort((a, b) => a - b);
  const entries = lengths.map((length) => {
    // Sort the bucket with the default comparison of JavaScript, which uses
    // UTF-16 code units. `commonPasswords.ts` uses the same comparison for its
    // binary search.
    const bucket = byLength.get(length)!.sort();
    const items = bucket.map((password) => JSON.stringify(password)).join(",");
    return `  ${length}: [${items}],`;
  });

  return `/* eslint-disable */
/**
 * The most frequent passwords with ${MIN_LENGTH} characters or more. The list
 * contains the ${METHOD_PASSWORD_COUNT} most frequent passwords with ${METHOD_MIN_LENGTH} characters or
 * more, and all the shorter passwords that are more frequent than the last of
 * them.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED. DO NOT EDIT IT.
 * To make it again, run \`bun run generate:common-passwords\` from
 * \`packages/core\`.
 *
 * Source: ${SOURCE_PATH}
 * from the SecLists repository (MIT license):
 * ${SECLISTS_REPOSITORY.replace(/\.git$/, "")}
 * That list comes from the UK National Cyber Security Centre (NCSC) and from
 * Have I Been Pwned.
 *
 * Each password is in the NFC form and is lowercase. The key of the map is the
 * length of the password in Unicode code points. Each array is in ascending
 * order, thus \`commonPasswords.ts\` can do a binary search.
 *
 * @generated
 * @module
 */

// prettier-ignore
export const COMMON_PASSWORDS_BY_LENGTH: Record<number, readonly string[]> = {
${entries.join("\n")}
};
`;
}
