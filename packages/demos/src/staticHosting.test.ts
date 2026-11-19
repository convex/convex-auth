// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { withStaticHosting } from "./staticHosting.ts";

const config = `import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";

const app = defineApp();

app.use(auth);

export default app;
`;

describe("withStaticHosting", () => {
  let exampleDir: string;
  let convexDir: string;

  beforeEach(async () => {
    exampleDir = await mkdtemp(join(tmpdir(), "demos-test-"));
    convexDir = join(exampleDir, "convex");
    await mkdir(join(convexDir, "_generated"), { recursive: true });
    await writeFile(join(convexDir, "convex.config.ts"), config);
    await writeFile(join(convexDir, "_generated", "api.d.ts"), "original");
  });

  afterEach(async () => {
    await rm(exampleDir, { recursive: true });
  });

  test("mounts the component at / while the function runs", async () => {
    const during = await withStaticHosting(exampleDir, () =>
      readFile(join(convexDir, "convex.config.ts"), "utf8"),
    );
    expect(during).toMatch(
      /^import staticHosting from "\.[^"]*\/@convex-dev\/static-hosting\/dist\/component\/convex\.config\.js";$/m,
    );
    expect(during).toContain(
      'app.use(staticHosting, { httpPrefix: "/" });\n\nexport default app;\n',
    );
  });

  test("puts back the config and the generated code", async () => {
    await withStaticHosting(exampleDir, async () => {
      await writeFile(join(convexDir, "_generated", "api.d.ts"), "changed");
      await writeFile(join(convexDir, "_generated", "new.d.ts"), "new");
    });
    expect(await readFile(join(convexDir, "convex.config.ts"), "utf8")).toBe(
      config,
    );
    expect(
      await readFile(join(convexDir, "_generated", "api.d.ts"), "utf8"),
    ).toBe("original");
    expect(existsSync(join(convexDir, "_generated", "new.d.ts"))).toBe(false);
  });

  test("puts back the files when the function fails", async () => {
    await expect(
      withStaticHosting(exampleDir, async () => {
        throw new Error("deploy failed");
      }),
    ).rejects.toThrow("deploy failed");
    expect(await readFile(join(convexDir, "convex.config.ts"), "utf8")).toBe(
      config,
    );
  });

  test("rejects an example with HTTP routes of its own", async () => {
    await writeFile(join(convexDir, "http.ts"), "");
    await expect(withStaticHosting(exampleDir, async () => {})).rejects.toThrow(
      "http.ts exists",
    );
  });

  test("rejects a config without `export default app;`", async () => {
    await writeFile(
      join(convexDir, "convex.config.ts"),
      "export default defineApp();\n",
    );
    await expect(withStaticHosting(exampleDir, async () => {})).rejects.toThrow(
      'does not end with "export default app;"',
    );
  });
});
