/**
 * Builds the structure model: finds the parts in the source, then runs the
 * analyzer from each part that holds code.
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import type {
  FunctionType,
  Part,
  PartKind,
  StructureModel,
  TableField,
  TableIndex,
  Visibility,
} from "../model.ts";
import {
  Analyzer,
  isFunctionLike,
  propertyNameText,
  type Env,
  type Owner,
  type Unit,
  type Val,
} from "./analyzer.ts";
import {
  coreSrc,
  createProgram,
  examples,
  examplesRoot,
  isInRepoOnly,
  listFiles,
  repoPath,
  stablePath,
} from "./program.ts";

/**
 * The third parties the code talks to, and the domains that identify each.
 * The model links a third party only to a host the code is seen to reach.
 */
const THIRD_PARTIES = [
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
  },
];

type ComponentInfo = {
  id: string;
  name: string;
  dir: string;
  /** Child name → part id. */
  children: Map<string, string>;
};

type ExampleInfo = {
  id: string;
  name: string;
  convexDir: string;
  /** Instance name → component part id. */
  instances: Map<string, string>;
};

export function buildModel(): StructureModel {
  const program = createProgram();
  const diagnostics = program
    .getSemanticDiagnostics()
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const shown = ts.formatDiagnostics(diagnostics.slice(0, 10), {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    });
    throw new Error(
      `The source does not typecheck under the generator's program:\n${shown}`,
    );
  }
  const analyzer = new Analyzer(program);
  const checker = analyzer.checker;
  const parts = new Map<string, Part>();
  const addPart = (part: Part) => {
    if (parts.has(part.id)) {
      throw new Error(`Two parts have the id ${part.id}`);
    }
    parts.set(part.id, part);
  };
  const sourceFile = (path: string) => {
    const file = program.getSourceFile(path);
    if (file === undefined) {
      throw new Error(`${path} is not in the program`);
    }
    return file;
  };
  const loc = (node: ts.Node) => analyzer.location(node);

  // ---------------------------------------------------------------- regions

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
  addPart({
    kind: "region",
    id: "region:app",
    name: "App backend",
    parent: null,
    source: null,
    region: "app",
  });
  for (const thirdParty of THIRD_PARTIES) {
    addPart({
      kind: "thirdParty",
      id: thirdParty.id,
      name: thirdParty.name,
      parent: null,
      source: null,
      hosts: [],
    });
  }

  // ------------------------------------------------------------- components

  const components: ComponentInfo[] = [];
  const componentsByDir = new Map<string, ComponentInfo>();
  const componentDirs = [
    join(coreSrc, "component"),
    ...readdirSync(join(coreSrc, "components"))
      .sort()
      .map((name) => join(coreSrc, "components", name))
      .filter((dir) => existsSync(join(dir, "convex.config.ts"))),
  ];
  for (const dir of [
    ...componentDirs,
    ...examples().map((e) => join(examplesRoot, e, "convex")),
  ]) {
    if (existsSync(join(dir, "crons.ts"))) {
      throw new Error(
        `${repoPath(dir)}/crons.ts: cron jobs are not modeled yet; teach the generator to read them`,
      );
    }
  }
  const externalComponents = new Map<
    string,
    { id: string; package: string; configFiles: Set<string> }
  >();
  const addExternal = (id: string, pkg: string, configFile: string) => {
    const entry = externalComponents.get(id) ?? {
      id,
      package: pkg,
      configFiles: new Set<string>(),
    };
    entry.configFiles.add(configFile);
    externalComponents.set(id, entry);
  };

  /** The component an `app.use` / `component.use` argument names. */
  const useTarget = (arg: ts.Expression) => {
    const symbol = checker.getSymbolAtLocation(arg);
    const importDecl = symbol?.declarations?.[0];
    if (importDecl === undefined || !ts.isImportClause(importDecl)) {
      return null;
    }
    const specifier = (importDecl.parent.moduleSpecifier as ts.StringLiteral)
      .text;
    const aliased = checker.getAliasedSymbol(symbol!);
    const target = aliased.declarations?.[0]?.getSourceFile().fileName;
    return { specifier, target };
  };

  /** The name `defineComponent` gives a component in a file of an npm package. */
  const externalComponentName = (declarationFile: string): string => {
    const jsFile = declarationFile.replace(/\.d\.ts$/, ".js");
    const text = readFileSync(jsFile, "utf8");
    const match = /defineComponent\(\s*["']([^"']+)["']/.exec(text);
    if (match === null) {
      throw new Error(`No defineComponent in ${jsFile}`);
    }
    return match[1]!;
  };

  const packageOf = (specifier: string) =>
    specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");

  const readEnv = (
    options: ts.Expression | undefined,
    ownerId: string,
    envPrefix: string,
  ) => {
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      return;
    }
    const envProperty = options.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && propertyNameText(p.name) === "env",
    );
    if (
      envProperty === undefined ||
      !ts.isObjectLiteralExpression(envProperty.initializer)
    ) {
      return;
    }
    for (const property of envProperty.initializer.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const name = propertyNameText(property.name)!;
      const validator = checker.getTypeAtLocation(property.initializer);
      addPart({
        kind: "envVar",
        id: `env:${envPrefix}.${name}`,
        name,
        parent: ownerId,
        source: loc(property),
        ...validatorType(checker, validator, property.initializer),
      });
    }
  };

  const findCalls = (
    file: ts.SourceFile,
    predicate: (call: ts.CallExpression) => boolean,
  ) => {
    const out: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && predicate(node)) {
        out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return out;
  };
  const calleeName = (call: ts.CallExpression) =>
    ts.isIdentifier(call.expression)
      ? call.expression.text
      : ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : null;

  for (const dir of componentDirs) {
    const config = sourceFile(join(dir, "convex.config.ts"));
    const define = findCalls(
      config,
      (c) => calleeName(c) === "defineComponent",
    )[0];
    if (define === undefined || !ts.isStringLiteral(define.arguments[0]!)) {
      throw new Error(
        `${repoPath(config.fileName)}: no defineComponent("<name>")`,
      );
    }
    const name = define.arguments[0].text;
    const info: ComponentInfo = {
      id: `component:${name}`,
      name,
      dir,
      children: new Map(),
    };
    components.push(info);
    componentsByDir.set(dir, info);
    addPart({
      kind: "component",
      id: info.id,
      name,
      parent: null,
      source: loc(define),
      componentName: name,
      package: null,
    });
    readEnv(define.arguments[1], info.id, name);
    for (const use of findCalls(
      config,
      (c) =>
        calleeName(c) === "use" && ts.isPropertyAccessExpression(c.expression),
    )) {
      const target = useTarget(use.arguments[0]!);
      if (target === null || target.target === undefined) {
        throw new Error(
          `${repoPath(config.fileName)}: cannot resolve the component of ${use.getText()}`,
        );
      }
      const childName =
        optionName(use.arguments[1]) ?? externalComponentName(target.target);
      const id = `component:${name}/${childName}`;
      info.children.set(childName, id);
      addPart({
        kind: "component",
        id,
        name: childName,
        parent: info.id,
        source: loc(use),
        componentName: childName,
        package: packageOf(target.specifier),
      });
      addExternal(id, packageOf(target.specifier), target.target);
      analyzer.addDependency("usesComponent", info.id, id, [loc(use)]);
    }
  }

  // ---------------------------------------------------------------- examples

  const exampleInfos: ExampleInfo[] = [];
  const examplesByDir = new Map<string, ExampleInfo>();
  const componentByConfigFile = new Map(
    components.map((c) => [join(c.dir, "convex.config.ts"), c]),
  );
  for (const name of examples()) {
    const convexDir = join(examplesRoot, name, "convex");
    const config = sourceFile(join(convexDir, "convex.config.ts"));
    const define = findCalls(config, (c) => calleeName(c) === "defineApp")[0]!;
    const info: ExampleInfo = {
      id: `example:${name}`,
      name,
      convexDir,
      instances: new Map(),
    };
    exampleInfos.push(info);
    examplesByDir.set(convexDir, info);
    addPart({
      kind: "exampleApp",
      id: info.id,
      name,
      parent: "region:app",
      source: loc(define),
      directory: name,
    });
    readEnv(define.arguments[0], info.id, `app:${name}`);
    for (const use of findCalls(
      config,
      (c) =>
        calleeName(c) === "use" && ts.isPropertyAccessExpression(c.expression),
    )) {
      const target = useTarget(use.arguments[0]!);
      if (target === null || target.target === undefined) {
        throw new Error(
          `${repoPath(config.fileName)}: cannot resolve the component of ${use.getText()}`,
        );
      }
      const ours = componentByConfigFile.get(target.target);
      let id: string;
      let defaultName: string;
      if (ours !== undefined) {
        id = ours.id;
        defaultName = ours.name;
      } else {
        defaultName = externalComponentName(target.target);
        id = `component:${defaultName}`;
        if (!parts.has(id)) {
          addPart({
            kind: "component",
            id,
            name: defaultName,
            parent: "region:app",
            source: null,
            componentName: defaultName,
            package: packageOf(target.specifier),
          });
        }
        addExternal(id, packageOf(target.specifier), target.target);
      }
      info.instances.set(optionName(use.arguments[1]) ?? defaultName, id);
      analyzer.addDependency("mounts", info.id, id, [loc(use)]);
    }
  }

  // ------------------------------------------------------------------ tables

  const tableIds = new Set<string>();
  const readSchema = (schemaFile: string, parent: string, prefix: string) => {
    if (!existsSync(schemaFile)) {
      return;
    }
    const file = sourceFile(schemaFile);
    const define = findCalls(file, (c) => calleeName(c) === "defineSchema")[0];
    const tables = define?.arguments[0];
    if (tables === undefined || !ts.isObjectLiteralExpression(tables)) {
      throw new Error(`${repoPath(schemaFile)}: no defineSchema({...})`);
    }
    for (const property of tables.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(
          `${repoPath(schemaFile)}: unexpected ${property.getText()}`,
        );
      }
      const name = propertyNameText(property.name)!;
      const id = `table:${prefix}.${name}`;
      tableIds.add(id);
      addPart({
        kind: "table",
        id,
        name,
        parent,
        source: loc(property),
        ...tableShape(checker, property.initializer),
      });
    }
  };
  for (const component of components) {
    readSchema(join(component.dir, "schema.ts"), component.id, component.name);
  }
  for (const example of exampleInfos) {
    readSchema(
      join(example.convexDir, "schema.ts"),
      example.id,
      `app:${example.name}`,
    );
  }

  // --------------------------------------------------------------- functions

  type FunctionDefinition = {
    exprs: { expr: ts.Node | undefined; env: Env }[];
    unit: Unit;
  };
  const functionDefinitions: FunctionDefinition[] = [];
  const functionIds = new Set<string>();

  /** The modules a `_generated/api` file lists. */
  const generatedModules = (dir: string): string[] => {
    const apiFile = [
      join(dir, "_generated", "api.ts"),
      join(dir, "_generated", "api.d.ts"),
    ].find(existsSync)!;
    const text = readFileSync(apiFile, "utf8");
    return [
      ...text.matchAll(/import type \* as \w+ from "\.\.\/(.+)\.js";/g),
    ].map((m) => m[1]!);
  };

  const readFunctions = (
    dir: string,
    owner: Owner,
    parent: string,
    idPrefix: string,
  ) => {
    for (const module of generatedModules(dir)) {
      const path = [join(dir, module + ".ts"), join(dir, module + ".tsx")].find(
        existsSync,
      );
      if (path === undefined) {
        throw new Error(
          `${repoPath(dir)}: the module ${module} of _generated/api has no source`,
        );
      }
      const file = sourceFile(path);
      const moduleSymbol = checker.getSymbolAtLocation(file);
      if (moduleSymbol === undefined) {
        continue;
      }
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
        const declaration = symbol.valueDeclaration;
        if (declaration === undefined) {
          continue;
        }
        const kind = registeredKind(
          checker.getTypeOfSymbolAtLocation(symbol, declaration),
        );
        if (kind === null) {
          continue;
        }
        if (symbol.name === "default" && kind.functionType === "httpAction") {
          continue;
        }
        const id = `${idPrefix}:${module}.${symbol.name}`;
        functionIds.add(id);
        addPart({
          kind: "function",
          id,
          name: symbol.name,
          parent,
          source: loc(declaration),
          module,
          functionType: kind.functionType,
          visibility: kind.visibility,
        });
        const unit: Unit = {
          from: id,
          owner,
          example: owner.kind === "app" ? owner.example : undefined,
          mode: "server",
        };
        let exprs: { expr: ts.Node | undefined; env: Env }[];
        if (ts.isVariableDeclaration(declaration)) {
          exprs = [{ expr: declaration.initializer, env: analyzer.rootEnv }];
        } else if (ts.isBindingElement(declaration)) {
          // A function some factory returns: follow the property it is taken
          // from to the expression that registers it.
          exprs = analyzer
            .evaluateBindingElement(declaration, analyzer.rootEnv)
            .flatMap(({ expr, env }) => analyzer.trace(expr, env));
        } else {
          exprs = [{ expr: declaration, env: analyzer.rootEnv }];
        }
        if (exprs.length === 0) {
          analyzer.addUnresolved(
            unit,
            "call",
            declaration,
            "The definition of the function is not one the analysis can trace",
          );
        }
        functionDefinitions.push({ exprs, unit });
      }
    }
  };
  for (const component of components) {
    readFunctions(
      component.dir,
      { kind: "component", name: component.name, dir: component.dir },
      component.id,
      `fn:${component.name}`,
    );
  }
  for (const example of exampleInfos) {
    readFunctions(
      example.convexDir,
      { kind: "app", example: example.name, dir: example.convexDir },
      example.id,
      `fn:app:${example.name}`,
    );
  }

  // The functions of the components that live in npm packages, from the
  // `ComponentApi` types their parents see.
  const externalFunctions = (
    ownerApiFile: string,
    instance: string,
    componentId: string,
    idPrefix: string,
  ) => {
    const file = sourceFile(ownerApiFile);
    const symbol = checker
      .getExportsOfModule(checker.getSymbolAtLocation(file)!)
      .find((s) => s.name === "components");
    if (symbol?.valueDeclaration === undefined) {
      throw new Error(`${repoPath(ownerApiFile)}: no components`);
    }
    const instanceSymbol = checker
      .getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
      .getProperty(instance);
    if (instanceSymbol === undefined) {
      throw new Error(`${repoPath(ownerApiFile)}: no components.${instance}`);
    }
    const visit = (type: ts.Type, path: string[]) => {
      for (const property of type.getProperties()) {
        const propertyType = checker.getTypeOfSymbol(property);
        const functionType = propertyType.getProperty("_type");
        if (functionType !== undefined) {
          const literal = checker
            .typeToString(checker.getTypeOfSymbol(functionType))
            .replace(/"/g, "");
          const id = `${idPrefix}:${path.join("/")}.${property.name}`;
          if (parts.has(id)) {
            continue;
          }
          functionIds.add(id);
          addPart({
            kind: "function",
            id,
            name: property.name,
            parent: componentId,
            source:
              property.declarations?.[0] === undefined
                ? null
                : loc(property.declarations[0]),
            module: path.join("/"),
            functionType: literal as FunctionType,
            // `ComponentApi` lists only the functions the parent may call.
            visibility: "public",
          });
        } else if (path.length < 4) {
          visit(propertyType, [...path, property.name]);
        }
      }
    };
    visit(checker.getTypeOfSymbol(instanceSymbol), []);
  };
  for (const component of components) {
    for (const [child, id] of component.children) {
      externalFunctions(
        join(component.dir, "_generated", "api.ts"),
        child,
        id,
        `fn:${component.name}/${child}`,
      );
    }
  }
  for (const example of exampleInfos) {
    for (const [instance, id] of example.instances) {
      if (externalComponents.has(id)) {
        externalFunctions(
          join(example.convexDir, "_generated", "api.d.ts"),
          instance,
          id,
          `fn:${parts.get(id)!.name}`,
        );
      }
    }
  }

  // ----------------------------------------------- methods, hooks, modules

  const methodsDir = join(coreSrc, "methods");
  const methodDirs = readdirSync(methodsDir)
    .filter((name) => statSync(join(methodsDir, name)).isDirectory())
    .sort();
  type MethodFunctionDefinition = {
    id: string;
    expr: ts.Node;
    locNode: ts.Node;
  };
  const methodFunctionByNode = new Map<ts.Node, string>();
  const methodFunctionDefinitions: MethodFunctionDefinition[] = [];
  const setupFunctions = new Map<ts.Node, string>();

  const readSetupFunctions = (
    serverFile: string,
    parent: string,
    prefix: string,
  ) => {
    const file = sourceFile(serverFile);
    const moduleSymbol = checker.getSymbolAtLocation(file)!;
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
          if (parts.has(id)) {
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
          methodFunctionDefinitions.push({
            id,
            expr: definition.expr,
            locNode: definition.locNode,
          });
        },
      );
    }
  };
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

  // The core's own setup lives in `server/`.
  readSetupFunctions(join(coreSrc, "server", "setup.ts"), "region:app", "core");

  const hookByNode = new Map<ts.Node, string>();
  const moduleFiles: {
    file: ts.SourceFile;
    id: string;
    runsIn: "browser" | "ssr";
  }[] = [];
  const addModule = (
    path: string,
    parent: string,
    runsIn: "browser" | "ssr",
  ) => {
    const file = sourceFile(path);
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
      source: { file: repoPath(path), line: 1 },
      module,
      runsIn: actualRunsIn,
    });
    moduleFiles.push({ file, id, runsIn: actualRunsIn });
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
      let node: ts.Node | undefined = declaration;
      if (ts.isVariableDeclaration(declaration)) {
        node = declaration.initializer;
      }
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

  for (const directory of methodDirs) {
    const dir = join(methodsDir, directory);
    const methodId = `method:${directory}`;
    const serverFile = join(dir, "server.ts");
    addPart({
      kind: "method",
      id: methodId,
      name: directory,
      parent: null,
      source: existsSync(serverFile)
        ? { file: repoPath(serverFile), line: 1 }
        : null,
      directory,
      entryPoint: existsSync(serverFile)
        ? `@convex-dev/auth/methods/${directory}/server`
        : null,
    });
    if (existsSync(serverFile)) {
      readSetupFunctions(serverFile, methodId, directory);
    }
    for (const path of listFiles(
      dir,
      (p) => /\.tsx?$/.test(p) && !isInRepoOnly(p),
    )) {
      const base = relative(dir, path);
      if (base === "server.ts" || base === "index.ts") {
        continue;
      }
      addModule(path, methodId, "browser");
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
        analyzer.addDependency("imports", id, target, [loc(statement)]);
      }
    }
  }

  // --------------------------------------------------------------- resolvers

  const ownerOfDir = (dir: string): Owner | null => {
    const component = componentsByDir.get(dir);
    if (component !== undefined) {
      return { kind: "component", name: component.name, dir };
    }
    const example = examplesByDir.get(dir);
    if (example !== undefined) {
      return { kind: "app", example: example.name, dir };
    }
    return null;
  };
  /** The prefix of the function ids of a component part. */
  const functionPrefixOf = (componentId: string) =>
    `fn:${componentId.slice("component:".length)}`;
  const componentFromRef = (ownerDir: string, name: string): string | null => {
    const component = componentsByDir.get(ownerDir);
    if (component !== undefined) {
      return component.children.get(name) ?? null;
    }
    return examplesByDir.get(ownerDir)?.instances.get(name) ?? null;
  };
  const checkFunction = (id: string) => (functionIds.has(id) ? id : null);
  const routesByHandler = new Map<string, string>();
  const handlerWalks: { id: string; node: ts.Node; env: Env; unit: Unit }[] =
    [];

  analyzer.resolvers = {
    functionFromRef(ref: Extract<Val, { k: "ref" }>) {
      const owner = ownerOfDir(ref.ownerDir);
      if (owner === null) {
        return null;
      }
      if (ref.root === "components") {
        if (ref.path.length < 3) {
          return null;
        }
        const component = componentFromRef(ref.ownerDir, ref.path[0]!);
        if (component === null) {
          return null;
        }
        const rest = ref.path.slice(1);
        return checkFunction(
          `${functionPrefixOf(component)}:${rest.slice(0, -1).join("/")}.${rest.at(-1)}`,
        );
      }
      if (ref.path.length < 2) {
        return null;
      }
      const prefix =
        owner.kind === "component"
          ? `fn:${owner.name}`
          : `fn:app:${owner.example}`;
      return checkFunction(
        `${prefix}:${ref.path.slice(0, -1).join("/")}.${ref.path.at(-1)}`,
      );
    },
    functionFromComponentApi(dir: string, path: string[]) {
      const component = componentsByDir.get(dir);
      if (component === undefined || path.length < 2) {
        return null;
      }
      return checkFunction(
        `fn:${component.name}:${path.slice(0, -1).join("/")}.${path.at(-1)}`,
      );
    },
    componentFromRef,
    componentPackage(id: string) {
      return externalComponents.get(id)?.package ?? null;
    },
    table(owner: Owner, table: string) {
      const id =
        owner.kind === "component"
          ? `table:${owner.name}.${table}`
          : `table:app:${owner.example}.${table}`;
      return tableIds.has(id) ? id : null;
    },
    envVar(owner: Owner, name: string) {
      const id =
        owner.kind === "component"
          ? `env:${owner.name}.${name}`
          : `env:app:${owner.example}.${name}`;
      return parts.has(id) ? id : null;
    },
    thirdParty(host: string) {
      const match = THIRD_PARTIES.find((t) =>
        t.domains.some((d) => host === d || host.endsWith("." + d)),
      );
      if (match === undefined) {
        return null;
      }
      const part = parts.get(match.id) as Extract<Part, { kind: "thirdParty" }>;
      if (!part.hosts.includes(host)) {
        part.hosts.push(host);
        part.hosts.sort();
      }
      return match.id;
    },
    passkeyAuthenticator: "thirdParty:passkeyAuthenticator",
    partOfFunction(node: ts.Node) {
      return hookByNode.get(node) ?? null;
    },
    onRoute({ unit, call, path, method, handler }) {
      const owner = unit.owner;
      if (owner === null || owner.kind !== "component") {
        analyzer.addUnresolved(
          { ...unit, silent: false },
          "httpRoute",
          call,
          "A route outside of a component",
        );
        return;
      }
      const paths = path
        .filter((v) => v.k === "str")
        .map((v) => (v as { value: string }).value);
      const methods = method
        .filter((v) => v.k === "str")
        .map((v) => (v as { value: string }).value);
      const reportUnit = { ...unit, silent: false };
      if (paths.length === 0 || paths.length !== path.length) {
        analyzer.addUnresolved(
          reportUnit,
          "httpRoute",
          call,
          "The route's path is not a literal the analysis can trace",
        );
        return;
      }
      if (methods.length === 0 || methods.length !== method.length) {
        analyzer.addUnresolved(
          reportUnit,
          "httpRoute",
          call,
          "The route's method is not a literal the analysis can trace",
        );
        return;
      }
      let handlerId: string | null = null;
      if (handler !== null) {
        handlerId =
          routesByHandler.get(`${owner.name}|${handler.node.pos}`) ?? null;
        if (handlerId === null) {
          handlerId = `httpAction:${owner.name}:${paths.join("|")}`;
          routesByHandler.set(`${owner.name}|${handler.node.pos}`, handlerId);
          addPart({
            kind: "function",
            id: handlerId,
            name: `httpAction ${paths.join(", ")}`,
            parent: `component:${owner.name}`,
            source: loc(handler.node),
            module: "http",
            functionType: "httpAction",
            visibility: "public",
          });
          handlerWalks.push({
            id: handlerId,
            node: handler.node,
            env: handler.env,
            unit: {
              from: handlerId,
              owner,
              example: undefined,
              mode: "server",
            },
          });
        }
      } else {
        analyzer.addUnresolved(
          reportUnit,
          "httpRoute",
          call,
          "The route's handler is not an httpAction the analysis can trace",
        );
      }
      for (const p of paths) {
        for (const m of methods) {
          const routeId = `route:${owner.name}:${m} ${p}`;
          if (!parts.has(routeId)) {
            addPart({
              kind: "httpRoute",
              id: routeId,
              name: `${m} ${p}`,
              parent: `component:${owner.name}`,
              source: loc(call),
              path: p,
              method: m,
            });
          }
          if (handlerId !== null) {
            analyzer.addDependency("routesTo", routeId, handlerId, [loc(call)]);
          }
        }
      }
    },
  };

  // ------------------------------------------------------------------- walks

  for (const { exprs, unit } of functionDefinitions) {
    for (const { expr, env } of exprs) {
      if (expr !== undefined) {
        analyzer.walk(expr, env, unit);
        const definedBy = enclosingMethodFunction(expr, methodFunctionByNode);
        if (definedBy !== null && unit.owner?.kind === "app") {
          analyzer.addDependency("definedBy", unit.from, definedBy, [
            loc(expr),
          ]);
        }
      }
    }
  }
  for (const { id, expr } of methodFunctionDefinitions) {
    analyzer.walk(expr, analyzer.rootEnv, {
      from: id,
      owner: null,
      example: undefined,
      mode: "server",
    });
  }
  // HTTP routers: a silent walk of each `http.ts` finds the routes, then each
  // handler is walked as a function of its own.
  for (const component of components) {
    const httpFile = join(component.dir, "http.ts");
    if (!existsSync(httpFile)) {
      continue;
    }
    const file = sourceFile(httpFile);
    const owner: Owner = {
      kind: "component",
      name: component.name,
      dir: component.dir,
    };
    for (const statement of file.statements) {
      analyzer.walk(statement, analyzer.rootEnv, {
        from: component.id,
        owner,
        example: undefined,
        mode: "server",
        silent: true,
      });
    }
  }
  for (const { node, env, unit } of handlerWalks) {
    analyzer.walkFunction({ k: "node", node, env }, env, unit, 0);
  }
  // Browser and SSR modules, on their own: what they fetch and which WebAuthn
  // ceremonies they run.
  for (const { file, id } of moduleFiles) {
    analyzer.walkModule(file, {
      from: id,
      owner: null,
      example: undefined,
      mode: "client",
    });
  }
  // The example apps: which methods they set up, and the frontend code down
  // through the hooks to the app functions it calls.
  for (const example of exampleInfos) {
    const root = join(examplesRoot, example.name);
    for (const path of listFiles(
      root,
      (p) => /\.tsx?$/.test(p) && !p.endsWith(".d.ts"),
    )) {
      const rel = relative(root, path);
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
          const methodId = parts.get(setupId)!.parent!;
          analyzer.addDependency(
            "usesMethod",
            example.id,
            methodId.startsWith("method:") ? methodId : setupId,
            [loc(call)],
          );
        }
      }
      if (
        rel.startsWith("convex" + sep) ||
        /\.config\.ts$/.test(rel) ||
        /\.test\.tsx?$/.test(rel)
      ) {
        continue;
      }
      analyzer.walkModule(file, {
        from: example.id,
        owner: null,
        example: example.name,
        mode: "client",
      });
    }
  }
  // Fetches by the components that live in npm packages.
  for (const { id, configFiles } of externalComponents.values()) {
    for (const path of [...configFiles]
      .sort()
      .flatMap((f) => listFilesInPackage(dirname(f)))) {
      const text = readFileSync(path, "utf8");
      const file = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.ESNext,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "fetch" &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const host = new URL(node.arguments[0].text).host;
          const target = analyzer.resolvers.thirdParty(host);
          if (target !== null) {
            const { line } = file.getLineAndCharacterOfPosition(
              node.getStart(file),
            );
            analyzer.addDependency(
              "fetches",
              id,
              target,
              [{ file: stablePath(path), line: line + 1 }],
              { via: host },
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }

  return assemble([...parts.values()], analyzer.results());
}

function listFilesInPackage(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => join(dir, name));
}

function optionName(options: ts.Expression | undefined): string | null {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return null;
  }
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "name" &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return null;
}

/** The method function whose definition holds a node, if any. */
function enclosingMethodFunction(
  node: ts.Node,
  byNode: Map<ts.Node, string>,
): string | null {
  for (
    let current: ts.Node | undefined = node;
    current !== undefined;
    current = current.parent
  ) {
    const id = byNode.get(current);
    if (id !== undefined) {
      return id;
    }
  }
  return null;
}

/** Whether a type is a registered Convex function, and which. */
function registeredKind(
  type: ts.Type,
): { functionType: FunctionType; visibility: Visibility } | null {
  const flag = (name: string) => type.getProperty(name) !== undefined;
  let functionType: FunctionType;
  if (flag("isQuery")) {
    functionType = "query";
  } else if (flag("isMutation")) {
    functionType = "mutation";
  } else if (flag("isAction")) {
    functionType = "action";
  } else if (flag("isHttp")) {
    functionType = "httpAction";
  } else {
    return null;
  }
  return {
    functionType,
    visibility: flag("isInternal") ? "internal" : "public",
  };
}

/**
 * The expression that defines a member of a returned object: the property's
 * value, or the initializer of the constant it names. A member that an
 * interface declares is found through the object literal it is contextually
 * typed as.
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
    // The object literal property in the setup function typed by this member.
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

/** The fields and indexes of a table, from the type of its `defineTable` expression. */
function tableShape(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): { fields: TableField[]; indexes: TableIndex[] } {
  const type = checker.getTypeAtLocation(expr);
  const validator = type.getProperty("validator");
  if (validator === undefined) {
    throw new Error(`Not a table: ${expr.getText()}`);
  }
  const fieldsSymbol = checker.getTypeOfSymbol(validator).getProperty("fields");
  const fields: TableField[] = [];
  for (const field of fieldsSymbol === undefined
    ? []
    : checker.getTypeOfSymbol(fieldsSymbol).getProperties()) {
    fields.push({
      name: field.name,
      ...validatorType(checker, checker.getTypeOfSymbol(field), expr),
    });
  }
  const indexes: TableIndex[] = [];
  const args = checker.getTypeArguments(type as ts.TypeReference);
  const indexesType = args[1];
  for (const index of indexesType === undefined
    ? []
    : indexesType.getProperties()) {
    const tuple = checker.getTypeOfSymbol(index);
    const elements = checker.getTypeArguments(tuple as ts.TypeReference);
    const names = elements.map((e) =>
      checker.typeToString(e).replace(/"/g, ""),
    );
    if (names.at(-1) === "_creationTime") {
      // Convex appends `_creationTime` to every index.
      names.pop();
    }
    indexes.push({ name: index.name, fields: names });
  }
  return { fields, indexes };
}

/** The TypeScript type a validator accepts, and whether it is optional. */
function validatorType(
  checker: ts.TypeChecker,
  validator: ts.Type,
  at: ts.Node,
): { type: string; optional: boolean } {
  const typeProperty = validator.getProperty("type");
  const optionalProperty = validator.getProperty("isOptional");
  if (typeProperty === undefined || optionalProperty === undefined) {
    throw new Error(`Not a validator at ${at.getText()}`);
  }
  const optional =
    checker.typeToString(checker.getTypeOfSymbol(optionalProperty)) ===
    '"optional"';
  let type = checker.typeToString(
    checker.getTypeOfSymbol(typeProperty),
    undefined,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
  );
  type = type.replace(/'/g, '"');
  if (optional) {
    type = type.replace(/ \| undefined$/, "");
  }
  return { type, optional };
}

function assemble(
  parts: Part[],
  { dependencies, unresolved }: ReturnType<Analyzer["results"]>,
): StructureModel {
  parts.sort((a, b) => a.id.localeCompare(b.id));
  for (const dependency of dependencies) {
    dependency.evidence.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
    dependency.via?.sort();
  }
  dependencies.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.example ?? "").localeCompare(b.example ?? ""),
  );
  unresolved.sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line ||
      a.kind.localeCompare(b.kind) ||
      a.reason.localeCompare(b.reason),
  );
  const ids = new Set(parts.map((p) => p.id));
  for (const part of parts) {
    if (part.parent !== null && !ids.has(part.parent)) {
      throw new Error(`${part.id}: no parent ${part.parent}`);
    }
  }
  for (const dependency of dependencies) {
    if (!ids.has(dependency.from) || !ids.has(dependency.to)) {
      throw new Error(
        `A dependency on a missing part: ${JSON.stringify(dependency)}`,
      );
    }
  }
  const count = <T extends string>(values: T[]) => {
    const out: Partial<Record<T, number>> = {};
    for (const value of [...values].sort()) {
      out[value] = (out[value] ?? 0) + 1;
    }
    return out;
  };
  return {
    version: 1,
    parts,
    dependencies,
    unresolved,
    counts: {
      parts: count(parts.map((p) => p.kind as PartKind)),
      dependencies: count(dependencies.map((d) => d.kind)),
      unresolved: count(unresolved.map((u) => u.kind)),
    },
  };
}
