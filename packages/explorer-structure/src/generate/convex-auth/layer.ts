/**
 * The Convex Auth layer: what only this repository has. It tells the generic
 * layer where the components and the example apps are and which third parties
 * the code talks to, then adds the sign-in methods, the React hooks, and the
 * browser and SSR modules, and walks the example frontends.
 *
 * Another project writes its own layer like this one, on the same generic
 * `ConvexProject`.
 *
 * @module
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type {
  ConvexAuthDependencyKind,
  ConvexAuthPart,
  ConvexAuthStructure,
} from "../../convex-auth/model.ts";
import type { FunctionType, Visibility } from "../../model.ts";
import { isFunctionLike, propertyNameText } from "../convex/analyzer.ts";
import {
  componentSourceFiles,
  createProgram,
  exportsToSource,
  packageComponentSources,
  isTypeScriptSource,
  listFiles,
  pathAliases,
} from "../convex/program.ts";
import {
  ConvexProject,
  findCalls,
  registeredKind,
  type ThirdParty,
} from "../convex/project.ts";

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
const coreRoot = join(repoRoot, "packages", "core");
const coreSrc = join(coreRoot, "src");
const examplesRoot = join(repoRoot, "examples");

/** The third parties the code talks to, and what identifies each. */
const THIRD_PARTIES: ThirdParty[] = [
  {
    id: "thirdParty:google",
    name: "Google",
    domains: ["google.com", "googleapis.com"],
  },
  { id: "thirdParty:apple", name: "Apple", domains: ["apple.com"] },
  { id: "thirdParty:github", name: "GitHub", domains: ["github.com"] },
  { id: "thirdParty:discord", name: "Discord", domains: ["discord.com"] },
  { id: "thirdParty:resend", name: "Resend", domains: ["resend.com"] },
  {
    id: "thirdParty:passkeyAuthenticator",
    name: "Passkey authenticator",
    domains: [],
    libraries: ["@simplewebauthn/browser"],
  },
];

/** The files the published build leaves out: tests and in-repo helpers. */
function isInRepoOnly(absolute: string): boolean {
  const rel = relative(coreSrc, absolute).split(sep).join("/");
  return (
    /\.(test|script|fixture)\.tsx?$/.test(rel) ||
    rel.startsWith("testing/") ||
    rel.startsWith("components/password/scripts/") ||
    [
      "components/passkeyTestSetup.ts",
      "components/emailTestSetup.ts",
      "components/totpTestSetup.ts",
      "methods/oauth/testFlow.ts",
      "react/testSignInApi.ts",
    ].includes(rel)
  );
}

function examples(): string[] {
  return readdirSync(examplesRoot)
    .filter((name) => statSync(join(examplesRoot, name)).isDirectory())
    .sort();
}

const isDirectory = (path: string) => statSync(path).isDirectory();

function ownComponentDirs(): string[] {
  return [
    join(coreSrc, "component"),
    ...readdirSync(join(coreSrc, "components"))
      .sort()
      .map((name) => join(coreSrc, "components", name))
      .filter((dir) => existsSync(join(dir, "convex.config.ts"))),
  ];
}

export function buildConvexAuthModel(): ConvexAuthStructure {
  const exampleNames = examples();
  const componentDirs = ownComponentDirs();
  const appDirs = exampleNames.map((name) =>
    join(examplesRoot, name, "convex"),
  );
  const program = createProgram({
    root: repoRoot,
    files: [
      // The shipped source of the npm components they mount.
      ...packageComponentSources(
        [...componentDirs, ...appDirs].map((dir) =>
          join(dir, "convex.config.ts"),
        ),
      ).flatMap(componentSourceFiles),
      ...listFiles(coreSrc, (p) => isTypeScriptSource(p) && !isInRepoOnly(p)),
      ...exampleNames.flatMap((example) =>
        listFiles(
          join(examplesRoot, example),
          (p) => isTypeScriptSource(p) && !/\.test\.tsx?$/.test(p),
        ),
      ),
    ],
    // The examples import `@convex-dev/auth/...`, whose `exports` point at
    // `dist/`; resolve them to the source so locations are source locations.
    sources: exportsToSource(coreRoot, coreSrc),
    aliases: new Map(
      exampleNames.map((e) => [
        join(examplesRoot, e),
        pathAliases(join(examplesRoot, e)),
      ]),
    ),
    // `import.meta.env` in the Vite examples.
    types: ["node", "vite/client"],
  });

  const project = new ConvexProject({
    root: repoRoot,
    program,
    components: [
      join(coreSrc, "component"),
      ...readdirSync(join(coreSrc, "components"))
        .sort()
        .map((name) => join(coreSrc, "components", name))
        .filter((dir) => existsSync(join(dir, "convex.config.ts"))),
    ],
    apps: exampleNames.map((name) => ({
      name,
      dir: join(examplesRoot, name, "convex"),
    })),
    thirdParties: THIRD_PARTIES,
  });
  const { analyzer, checker } = project;
  const addPart = (
    part: ConvexAuthPart | Parameters<typeof project.addPart>[0],
  ) => project.addPart(part);
  const loc = (node: ts.Node) => project.location(node);

  addPart({
    kind: "region",
    id: "region:browser",
    name: "Browser",
    parent: null,
    source: null,
    region: "browser",
  });
  addPart({
    kind: "region",
    id: "region:ssr",
    name: "SSR server (Next.js)",
    parent: null,
    source: null,
    region: "ssr",
  });

  // ------------------------------------------------- methods and setups

  const methodFunctionByNode = new Map<ts.Node, string>();
  const methodFunctionDefinitions: { id: string; expr: ts.Node }[] = [];
  const setupFunctions = new Map<ts.Node, string>();

  const collectRegistered = (
    type: ts.Type,
    depth: number,
    onRegistered: (
      property: ts.Symbol,
      kind: { functionType: FunctionType; visibility: Visibility },
    ) => void,
  ) => {
    for (const property of type.getProperties()) {
      const propertyType = checker.getTypeOfSymbol(property);
      const kind = registeredKind(propertyType);
      if (kind !== null) {
        onRegistered(property, kind);
      } else if (depth < 2) {
        for (const signature of propertyType.getCallSignatures()) {
          collectRegistered(signature.getReturnType(), depth + 1, onRegistered);
        }
      }
    }
  };

  /** The `setup…` functions of a module, and the app functions each returns. */
  const readSetupFunctions = (
    serverFile: string,
    parent: string,
    prefix: string,
  ) => {
    const moduleSymbol = checker.getSymbolAtLocation(
      project.sourceFile(serverFile),
    )!;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const declaration = symbol.valueDeclaration;
      if (
        declaration === undefined ||
        !ts.isFunctionDeclaration(declaration) ||
        !/^setup[A-Z]/.test(symbol.name)
      ) {
        continue;
      }
      const setupId = `setup:${prefix}.${symbol.name}`;
      setupFunctions.set(declaration, setupId);
      addPart({
        kind: "setupFunction",
        id: setupId,
        name: symbol.name,
        parent,
        source: loc(declaration),
      });
      const signature = checker.getSignatureFromDeclaration(declaration)!;
      collectRegistered(
        checker.getReturnTypeOfSignature(signature),
        0,
        (property, kind) => {
          const definition = memberDefinition(checker, property, declaration);
          if (definition === null) {
            throw new Error(
              `${symbol.name}: cannot find the definition of ${property.name}`,
            );
          }
          const id = `methodFn:${prefix}.${property.name}`;
          if (project.parts.has(id)) {
            return;
          }
          addPart({
            kind: "methodFunction",
            id,
            name: property.name,
            parent: setupId,
            source: loc(definition.locNode),
            functionType: kind.functionType,
            visibility: kind.visibility,
          });
          methodFunctionByNode.set(definition.locNode, id);
          methodFunctionDefinitions.push({ id, expr: definition.expr });
        },
      );
    }
  };

  // The core's own setup lives in `server/`.
  readSetupFunctions(join(coreSrc, "server", "setup.ts"), "region:app", "core");

  // ------------------------------------------------- modules and hooks

  const hookByNode = new Map<ts.Node, string>();
  const moduleFiles: { file: ts.SourceFile; id: string }[] = [];
  const addModule = (
    path: string,
    parent: string,
    runsIn: "browser" | "ssr",
  ) => {
    const file = project.sourceFile(path);
    const module = relative(coreSrc, path)
      .split(sep)
      .join("/")
      .replace(/\.tsx?$/, "");
    const actualRunsIn =
      runsIn === "ssr" && /^["']use client["']/.test(file.text.trimStart())
        ? "browser"
        : runsIn;
    const id = `module:${module}`;
    addPart({
      kind: "module",
      id,
      name: module,
      parent,
      source: { file: project.path(path), line: 1 },
      module,
      runsIn: actualRunsIn,
    });
    moduleFiles.push({ file, id });
    const moduleSymbol = checker.getSymbolAtLocation(file);
    for (const symbol of moduleSymbol === undefined
      ? []
      : checker.getExportsOfModule(moduleSymbol)) {
      const declaration = symbol.valueDeclaration;
      if (
        declaration === undefined ||
        !/^use[A-Z]/.test(symbol.name) ||
        declaration.getSourceFile() !== file
      ) {
        continue;
      }
      const node = ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : declaration;
      if (node === undefined || !isFunctionLike(node)) {
        continue;
      }
      const hookId = `hook:${module}.${symbol.name}`;
      addPart({
        kind: "hook",
        id: hookId,
        name: symbol.name,
        parent: id,
        source: loc(declaration),
        runsIn: actualRunsIn,
      });
      hookByNode.set(node, hookId);
    }
  };

  const methodsDir = join(coreSrc, "methods");
  for (const directory of readdirSync(methodsDir)
    .filter((n) => isDirectory(join(methodsDir, n)))
    .sort()) {
    const dir = join(methodsDir, directory);
    const methodId = `method:${directory}`;
    const serverFile = join(dir, "server.ts");
    const hasServer = existsSync(serverFile);
    addPart({
      kind: "method",
      id: methodId,
      name: directory,
      parent: null,
      source: hasServer ? { file: project.path(serverFile), line: 1 } : null,
      directory,
      entryPoint: hasServer
        ? `@convex-dev/auth/methods/${directory}/server`
        : null,
    });
    if (hasServer) {
      readSetupFunctions(serverFile, methodId, directory);
    }
    for (const path of listFiles(
      dir,
      (p) => /\.tsx?$/.test(p) && !isInRepoOnly(p),
    )) {
      const base = relative(dir, path);
      if (base !== "server.ts" && base !== "index.ts") {
        addModule(path, methodId, "browser");
      }
    }
  }
  for (const [layer, runsIn] of [
    ["browser", "browser"],
    ["react", "browser"],
    ["ssr", "ssr"],
  ] as const) {
    for (const path of listFiles(
      join(coreSrc, layer),
      (p) => /\.tsx?$/.test(p) && !isInRepoOnly(p),
    )) {
      addModule(path, `region:${runsIn}`, runsIn);
    }
  }

  // Imports between modules.
  const moduleByFile = new Map(moduleFiles.map((m) => [m.file.fileName, m.id]));
  for (const { file, id } of moduleFiles) {
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) {
        continue;
      }
      const resolved = ts.resolveModuleName(
        specifier.text,
        file.fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      const target =
        resolved === undefined ? undefined : moduleByFile.get(resolved);
      if (target !== undefined && target !== id) {
        project.addDependency("imports", id, target, statement);
      }
    }
  }

  // --------------------------------------------------------------- walks

  project.partOfFunction = (node) => hookByNode.get(node) ?? null;

  project.walkFunctions(({ expr, unit }) => {
    if (unit.owner?.kind !== "app") {
      return;
    }
    for (
      let current: ts.Node | undefined = expr;
      current !== undefined;
      current = current.parent
    ) {
      const definedBy = methodFunctionByNode.get(current);
      if (definedBy !== undefined) {
        project.addDependency("definedBy", unit.from, definedBy, expr);
        return;
      }
    }
  });
  for (const { id, expr } of methodFunctionDefinitions) {
    analyzer.walk(expr, analyzer.rootEnv, {
      from: id,
      owner: null,
      app: undefined,
      mode: "server",
    });
  }
  project.walkHttpRouters();
  // Browser and SSR modules, on their own: what they fetch and which
  // third-party libraries they call.
  for (const { file, id } of moduleFiles) {
    analyzer.walkModule(file, {
      from: id,
      owner: null,
      app: undefined,
      mode: "client",
    });
  }
  // The example apps: which methods they set up, and the frontend code down
  // through the hooks to the app functions it calls.
  for (const app of project.apps) {
    const root = join(examplesRoot, app.name);
    for (const path of listFiles(root, isTypeScriptSource)) {
      const file = program.getSourceFile(path);
      if (file === undefined) {
        continue;
      }
      for (const call of findCalls(file, () => true)) {
        const symbol = analyzer.symbolAt(
          ts.isPropertyAccessExpression(call.expression)
            ? call.expression.name
            : call.expression,
        );
        const setupId =
          symbol?.valueDeclaration === undefined
            ? undefined
            : setupFunctions.get(symbol.valueDeclaration);
        if (setupId !== undefined) {
          const parent = project.parts.get(setupId)!.parent!;
          project.addDependency(
            "usesMethod",
            app.id,
            parent.startsWith("method:") ? parent : setupId,
            call,
          );
        }
      }
      const rel = relative(root, path);
      if (
        rel.startsWith("convex" + sep) ||
        /\.config\.ts$/.test(rel) ||
        /\.test\.tsx?$/.test(rel)
      ) {
        continue;
      }
      analyzer.walkModule(file, {
        from: app.id,
        owner: null,
        app: app.name,
        mode: "client",
      });
    }
  }
  project.scanPackageFetches();

  return project.model<ConvexAuthPart, ConvexAuthDependencyKind>(
    "convex-auth",
    {
      parts: {
        method: {
          label: "Sign-in method",
          description: "A sign-in method of Convex Auth (methods/<name>).",
        },
        setupFunction: {
          label: "Setup function",
          description:
            "A setup… function: the app calls it to get its auth functions.",
        },
        methodFunction: {
          label: "Method function",
          description:
            "An app function a setup… function returns, as the library defines it.",
        },
        hook: {
          label: "React hook",
          description: "A React hook of the core or of a sign-in method.",
        },
        module: {
          label: "Client module",
          description: "A module of the browser or SSR code.",
        },
      },
      dependencies: {
        usesMethod: {
          label: "uses method",
          description:
            "An app sets up a sign-in method by calling its setup… function.",
        },
        definedBy: {
          label: "defined by",
          description:
            "An app function is the one a sign-in method's setup… returns.",
        },
        imports: { label: "imports", description: "A module imports another." },
      },
    },
  );
}

/**
 * The expression that defines a member of a returned object: the property's
 * value, or the initializer of the constant it names. A member that an
 * interface declares is found through the object literal in `scope` that is
 * contextually typed by it.
 */
function memberDefinition(
  checker: ts.TypeChecker,
  property: ts.Symbol,
  scope: ts.Node,
): { expr: ts.Node; locNode: ts.Node } | null {
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  if (declaration === undefined) {
    return null;
  }
  const throughConstant = (identifier: ts.Identifier, fallback: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const value =
      symbol === undefined
        ? undefined
        : (checker.getShorthandAssignmentValueSymbol(identifier.parent) ??
          symbol);
    const decl = value?.valueDeclaration;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined
    ) {
      return { expr: decl.initializer as ts.Node, locNode: decl as ts.Node };
    }
    return { expr: identifier as ts.Node, locNode: fallback };
  };
  if (ts.isPropertyAssignment(declaration)) {
    if (ts.isIdentifier(declaration.initializer)) {
      return throughConstant(declaration.initializer, declaration);
    }
    return { expr: declaration.initializer, locNode: declaration };
  }
  if (ts.isShorthandPropertyAssignment(declaration)) {
    return throughConstant(declaration.name, declaration);
  }
  if (ts.isPropertySignature(declaration)) {
    let found: ts.ObjectLiteralElementLike | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const member = checker
          .getContextualType(node)
          ?.getProperty(property.name);
        if (member?.declarations?.includes(declaration)) {
          found ??= node.properties.find(
            (p) =>
              p.name !== undefined &&
              propertyNameText(p.name) === property.name,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    if (found === undefined) {
      return null;
    }
    const symbol = checker.getSymbolAtLocation(found.name!);
    return symbol === undefined
      ? null
      : memberDefinition(checker, symbol, scope);
  }
  return null;
}
