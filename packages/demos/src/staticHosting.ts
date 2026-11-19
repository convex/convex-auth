import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Adds the static hosting component to the `convex.config.ts` of the example,
 * runs `fn`, and then puts back the files of the example.
 *
 * The examples are code for the readers of the docs, thus they do not mount
 * the static hosting component. The change exists only while the demo
 * deploys. The import uses a relative path to the copy of the component in
 * this package, thus the example does not need the dependency.
 */
export async function withStaticHosting<T>(
  exampleDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const convexDir = join(exampleDir, "convex");
  const configPath = join(convexDir, "convex.config.ts");
  if (existsSync(join(convexDir, "http.ts"))) {
    // The component takes `/`. Routes of the app would need the
    // `registerStaticRoutes` setup of the component, which is not done here.
    throw new Error(
      `${convexDir}/http.ts exists. The demos support only examples without HTTP routes of their own.`,
    );
  }

  const original = await readFile(configPath, "utf8");
  const exportLine = /^export default app;$/m;
  if (!exportLine.test(original)) {
    throw new Error(`${configPath} does not end with "export default app;"`);
  }
  const componentConfig = fileURLToPath(
    import.meta.resolve("@convex-dev/static-hosting/convex.config.js"),
  );
  let importPath = relative(convexDir, componentConfig).split(sep).join("/");
  if (!importPath.startsWith(".")) {
    importPath = `./${importPath}`;
  }
  const patched = original.replace(
    exportLine,
    [
      `import staticHosting from ${JSON.stringify(importPath)};`,
      `app.use(staticHosting, { httpPrefix: "/" });`,
      ``,
      `export default app;`,
    ].join("\n"),
  );

  // `convex deploy` also writes the code of `convex/_generated`.
  const generatedDir = join(convexDir, "_generated");
  const generated = await snapshot(generatedDir);

  await writeFile(configPath, patched);
  try {
    return await fn();
  } finally {
    await writeFile(configPath, original);
    await restore(generatedDir, generated);
  }
}

async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!existsSync(dir)) {
    return files;
  }
  for (const name of await readdir(dir)) {
    files.set(name, await readFile(join(dir, name)));
  }
  return files;
}

async function restore(dir: string, files: Map<string, Buffer>) {
  if (existsSync(dir)) {
    for (const name of await readdir(dir)) {
      if (!files.has(name)) {
        await rm(join(dir, name), { recursive: true });
      }
    }
  }
  for (const [name, content] of files) {
    await writeFile(join(dir, name), content);
  }
}

/**
 * Runs `static-hosting deploy` in the directory of the example. It builds the
 * frontend with the URL of the deployment, pushes the Convex functions, and
 * uploads the frontend.
 */
export async function deployWithStaticHosting(
  exampleDir: string,
  deployKey: string,
): Promise<void> {
  const packageJson =
    require.resolve("@convex-dev/static-hosting/package.json");
  const cli = join(dirname(packageJson), "dist", "cli", "index.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONVEX_DEPLOY_KEY: deployKey,
  };
  // The deploy key selects the deployment. Remove the other ways to select
  // one, so that a local `.env.local` or shell does not select another.
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_URL;

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // `vite build` only: the `build` scripts of the examples also typecheck,
      // which `convex deploy` does for the functions.
      [cli, "deploy", "--build-command", "pnpm exec vite build"],
      { cwd: exampleDir, env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`static-hosting deploy exited with code ${code}`);
  }
}
