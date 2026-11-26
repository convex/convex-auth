/**
 * The generic layer: the structure of any Convex project, read from its
 * `convex.config.ts`, `schema.ts`, and `_generated/api` files, and the
 * dependencies of its functions, read from their call sites. It knows Convex,
 * not any repository: the project layer says where the components and the
 * apps are, which third parties to name, and adds its own parts on top.
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import type {
  ConvexPart,
  FunctionType,
  PartBase,
  StructureModel,
  TableField,
  TableIndex,
  Visibility,
} from "../../model.ts";
import {
  Analyzer,
  propertyNameText,
  type Env,
  type Owner,
  type Unit,
  type Val,
} from "./analyzer.ts";
import { rootPath, stablePath } from "./program.ts";

/** A third party the code may talk to. */
export type ThirdParty = {
  /** The part id, e.g. `thirdParty:google`. */
  id: string;
  name: string;
  /** The hosts that identify it: a fetched URL on one of these, or a subdomain, reaches it. */
  domains: string[];
  /** npm packages whose functions talk to it, e.g. a WebAuthn library. */
  libraries?: string[];
};

export type ProjectOptions = {
  root: string;
  program: ts.Program;
  /** The directories of the project's own components, each with a `convex.config.ts` that calls `defineComponent`. */
  components: string[];
  /** The project's apps: a name and the `convex/` directory, with a `convex.config.ts` that calls `defineApp`. */
  apps: { name: string; dir: string }[];
  thirdParties: ThirdParty[];
};

type ComponentInfo = {
  id: string;
  name: string;
  dir: string;
  /** Child name → part id. */
  children: Map<string, string>;
};

type AppInfo = {
  id: string;
  name: string;
  dir: string;
  /** Instance name → component part id. */
  instances: Map<string, string>;
};

export type FunctionDefinition = {
  /** The expressions that register the function, in the env they are evaluated in. */
  exprs: { expr: ts.Node | undefined; env: Env }[];
  unit: Unit;
};

/** A part of the generic layer, or of a project layer. */
type AnyPart = PartBase & { kind: string } & Record<string, unknown>;

export class ConvexProject {
  readonly root: string;
  readonly program: ts.Program;
  readonly analyzer: Analyzer;
  readonly checker: ts.TypeChecker;
  readonly parts = new Map<string, AnyPart>();
  readonly components: ComponentInfo[] = [];
  readonly apps: AppInfo[] = [];
  readonly functionDefinitions: FunctionDefinition[] = [];
  /** A function whose walk records under a part of the project layer. */
  partOfFunction: (node: ts.Node) => string | null = () => null;

  private readonly thirdParties: ThirdParty[];
  private readonly componentsByDir = new Map<string, ComponentInfo>();
  private readonly appsByDir = new Map<string, AppInfo>();
  private readonly externalComponents = new Map<
    string,
    { package: string; configFiles: Set<string> }
  >();
  private readonly tableIds = new Set<string>();
  private readonly functionIds = new Set<string>();
  private readonly routesByHandler = new Map<string, string>();
  private readonly handlerWalks: { node: ts.Node; env: Env; unit: Unit }[] = [];

  constructor(options: ProjectOptions) {
    this.root = options.root;
    this.program = options.program;
    this.thirdParties = options.thirdParties;
    this.analyzer = new Analyzer(options.program, options.root);
    this.checker = this.analyzer.checker;

    this.addPart({
      kind: "region",
      id: "region:app",
      name: "App backend",
      parent: null,
      source: null,
      region: "app",
    });
    for (const thirdParty of options.thirdParties) {
      this.addPart({
        kind: "thirdParty",
        id: thirdParty.id,
        name: thirdParty.name,
        parent: null,
        source: null,
        hosts: [],
      });
    }
    for (const dir of [
      ...options.components,
      ...options.apps.map((a) => a.dir),
    ]) {
      if (existsSync(join(dir, "crons.ts"))) {
        throw new Error(
          `${this.path(dir)}/crons.ts: cron jobs are not modeled yet; teach the generator to read them`,
        );
      }
    }
    for (const dir of options.components) {
      this.readComponent(dir);
    }
    for (const app of options.apps) {
      this.readApp(app.name, app.dir);
    }
    for (const component of this.components) {
      this.readSchema(
        join(component.dir, "schema.ts"),
        component.id,
        component.name,
      );
    }
    for (const app of this.apps) {
      this.readSchema(join(app.dir, "schema.ts"), app.id, `app:${app.name}`);
    }
    for (const component of this.components) {
      this.readFunctions(
        component.dir,
        { kind: "component", name: component.name, dir: component.dir },
        component.id,
        `fn:${component.name}`,
      );
    }
    for (const app of this.apps) {
      this.readFunctions(
        app.dir,
        { kind: "app", name: app.name, dir: app.dir },
        app.id,
        `fn:app:${app.name}`,
      );
    }
    for (const component of this.components) {
      for (const [child, id] of component.children) {
        this.readPackageFunctions(
          join(component.dir, "_generated", "api.ts"),
          child,
          id,
          `fn:${component.name}/${child}`,
        );
      }
    }
    for (const app of this.apps) {
      for (const [instance, id] of app.instances) {
        if (this.externalComponents.has(id)) {
          this.readPackageFunctions(
            join(app.dir, "_generated", "api.d.ts"),
            instance,
            id,
            `fn:${this.parts.get(id)!.name}`,
          );
        }
      }
    }
    this.analyzer.resolvers = this.resolvers();
  }

  // ---------------------------------------------------------------- helpers

  addPart(part: AnyPart): void {
    if (this.parts.has(part.id)) {
      throw new Error(`Two parts have the id ${part.id}`);
    }
    this.parts.set(part.id, part);
  }

  addDependency(
    kind: string,
    from: string,
    to: string,
    node: ts.Node,
    extra: { via?: string; app?: string } = {},
  ): void {
    this.analyzer.addDependency(kind, from, to, [this.location(node)], extra);
  }

  path(absolute: string): string {
    return rootPath(this.root, absolute);
  }

  location(node: ts.Node) {
    return this.analyzer.location(node);
  }

  sourceFile(path: string): ts.SourceFile {
    const file = this.program.getSourceFile(path);
    if (file === undefined) {
      throw new Error(`${path} is not in the program`);
    }
    return file;
  }

  // ------------------------------------------------------------- discovery

  private readComponent(dir: string): void {
    const config = this.sourceFile(join(dir, "convex.config.ts"));
    const define = findCalls(
      config,
      (c) => calleeName(c) === "defineComponent",
    )[0];
    if (define === undefined || !ts.isStringLiteral(define.arguments[0]!)) {
      throw new Error(
        `${this.path(config.fileName)}: no defineComponent("<name>")`,
      );
    }
    const name = define.arguments[0].text;
    const info: ComponentInfo = {
      id: `component:${name}`,
      name,
      dir,
      children: new Map(),
    };
    this.components.push(info);
    this.componentsByDir.set(dir, info);
    this.addPart({
      kind: "component",
      id: info.id,
      name,
      parent: null,
      source: this.location(define),
      componentName: name,
      package: null,
    });
    this.readEnv(define.arguments[1], info.id, name);
    for (const use of useCalls(config)) {
      const target = this.useTarget(use);
      const childName =
        optionName(use.arguments[1]) ?? packageComponentName(target.target);
      const id = `component:${name}/${childName}`;
      info.children.set(childName, id);
      this.addPart({
        kind: "component",
        id,
        name: childName,
        parent: info.id,
        source: this.location(use),
        componentName: childName,
        package: packageOf(target.specifier),
      });
      this.addExternal(id, packageOf(target.specifier), target.target);
      this.addDependency("usesComponent", info.id, id, use);
    }
  }

  private readApp(name: string, dir: string): void {
    const config = this.sourceFile(join(dir, "convex.config.ts"));
    const define = findCalls(config, (c) => calleeName(c) === "defineApp")[0];
    if (define === undefined) {
      throw new Error(`${this.path(config.fileName)}: no defineApp()`);
    }
    const info: AppInfo = {
      id: `app:${name}`,
      name,
      dir,
      instances: new Map(),
    };
    this.apps.push(info);
    this.appsByDir.set(dir, info);
    this.addPart({
      kind: "app",
      id: info.id,
      name,
      parent: "region:app",
      source: this.location(define),
      path: this.path(dir),
    });
    this.readEnv(define.arguments[0], info.id, `app:${name}`);
    const ownByConfig = new Map(
      this.components.map((c) => [join(c.dir, "convex.config.ts"), c]),
    );
    for (const use of useCalls(config)) {
      const target = this.useTarget(use);
      const own = ownByConfig.get(target.target);
      let id: string;
      let defaultName: string;
      if (own !== undefined) {
        id = own.id;
        defaultName = own.name;
      } else {
        defaultName = packageComponentName(target.target);
        id = `component:${defaultName}`;
        if (!this.parts.has(id)) {
          this.addPart({
            kind: "component",
            id,
            name: defaultName,
            parent: "region:app",
            source: null,
            componentName: defaultName,
            package: packageOf(target.specifier),
          });
        }
        this.addExternal(id, packageOf(target.specifier), target.target);
      }
      info.instances.set(optionName(use.arguments[1]) ?? defaultName, id);
      this.addDependency("mounts", info.id, id, use);
    }
  }

  private addExternal(id: string, pkg: string, configFile: string): void {
    const entry = this.externalComponents.get(id) ?? {
      package: pkg,
      configFiles: new Set<string>(),
    };
    entry.configFiles.add(configFile);
    this.externalComponents.set(id, entry);
  }

  /** The component an `app.use` / `component.use` argument names. */
  private useTarget(use: ts.CallExpression): {
    specifier: string;
    target: string;
  } {
    const arg = use.arguments[0]!;
    const symbol = this.checker.getSymbolAtLocation(arg);
    const importDecl = symbol?.declarations?.[0];
    const target =
      symbol === undefined
        ? undefined
        : this.checker
            .getAliasedSymbol(symbol)
            .declarations?.[0]?.getSourceFile().fileName;
    if (
      importDecl === undefined ||
      !ts.isImportClause(importDecl) ||
      target === undefined
    ) {
      throw new Error(
        `${this.path(use.getSourceFile().fileName)}: cannot resolve the component of ${use.getText()}`,
      );
    }
    return {
      specifier: (importDecl.parent.moduleSpecifier as ts.StringLiteral).text,
      target,
    };
  }

  private readEnv(
    options: ts.Expression | undefined,
    ownerId: string,
    envPrefix: string,
  ): void {
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
      this.addPart({
        kind: "envVar",
        id: `env:${envPrefix}.${name}`,
        name,
        parent: ownerId,
        source: this.location(property),
        ...validatorType(
          this.checker,
          this.checker.getTypeAtLocation(property.initializer),
          property.initializer,
        ),
      });
    }
  }

  private readSchema(schemaFile: string, parent: string, prefix: string): void {
    if (!existsSync(schemaFile)) {
      return;
    }
    const file = this.sourceFile(schemaFile);
    const define = findCalls(file, (c) => calleeName(c) === "defineSchema")[0];
    const tables = define?.arguments[0];
    if (tables === undefined || !ts.isObjectLiteralExpression(tables)) {
      throw new Error(`${this.path(schemaFile)}: no defineSchema({...})`);
    }
    for (const property of tables.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(
          `${this.path(schemaFile)}: unexpected ${property.getText()}`,
        );
      }
      const name = propertyNameText(property.name)!;
      const id = `table:${prefix}.${name}`;
      this.tableIds.add(id);
      this.addPart({
        kind: "table",
        id,
        name,
        parent,
        source: this.location(property),
        ...tableShape(this.checker, property.initializer),
      });
    }
  }

  /** The modules a `_generated/api` file lists. */
  private generatedModules(dir: string): string[] {
    const apiFile = [
      join(dir, "_generated", "api.ts"),
      join(dir, "_generated", "api.d.ts"),
    ].find(existsSync);
    if (apiFile === undefined) {
      throw new Error(`${this.path(dir)}: no _generated/api; run codegen`);
    }
    const text = readFileSync(apiFile, "utf8");
    return [
      ...text.matchAll(/import type \* as \w+ from "\.\.\/(.+)\.js";/g),
    ].map((m) => m[1]!);
  }

  private readFunctions(
    dir: string,
    owner: Owner,
    parent: string,
    idPrefix: string,
  ): void {
    const { analyzer, checker } = this;
    for (const module of this.generatedModules(dir)) {
      const path = [join(dir, module + ".ts"), join(dir, module + ".tsx")].find(
        existsSync,
      );
      if (path === undefined) {
        throw new Error(
          `${this.path(dir)}: the module ${module} of _generated/api has no source`,
        );
      }
      const moduleSymbol = checker.getSymbolAtLocation(this.sourceFile(path));
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
        if (
          kind === null ||
          (symbol.name === "default" && kind.functionType === "httpAction")
        ) {
          continue;
        }
        const id = `${idPrefix}:${module}.${symbol.name}`;
        this.functionIds.add(id);
        this.addPart({
          kind: "function",
          id,
          name: symbol.name,
          parent,
          source: this.location(declaration),
          module,
          functionType: kind.functionType,
          visibility: kind.visibility,
        });
        const unit: Unit = {
          from: id,
          owner,
          app: owner.kind === "app" ? owner.name : undefined,
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
        this.functionDefinitions.push({ exprs, unit });
      }
    }
  }

  /**
   * The functions of a component that lives in an npm package, from the
   * `ComponentApi` type its parent sees.
   */
  private readPackageFunctions(
    ownerApiFile: string,
    instance: string,
    componentId: string,
    idPrefix: string,
  ): void {
    const { checker } = this;
    const file = this.sourceFile(ownerApiFile);
    const symbol = checker
      .getExportsOfModule(checker.getSymbolAtLocation(file)!)
      .find((s) => s.name === "components");
    if (symbol?.valueDeclaration === undefined) {
      throw new Error(`${this.path(ownerApiFile)}: no components`);
    }
    const instanceSymbol = checker
      .getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
      .getProperty(instance);
    if (instanceSymbol === undefined) {
      throw new Error(`${this.path(ownerApiFile)}: no components.${instance}`);
    }
    const visit = (type: ts.Type, path: string[]) => {
      for (const property of type.getProperties()) {
        const propertyType = checker.getTypeOfSymbol(property);
        const functionType = propertyType.getProperty("_type");
        if (functionType !== undefined) {
          const id = `${idPrefix}:${path.join("/")}.${property.name}`;
          if (this.parts.has(id)) {
            continue;
          }
          this.functionIds.add(id);
          const declaration = property.declarations?.[0];
          this.addPart({
            kind: "function",
            id,
            name: property.name,
            parent: componentId,
            source:
              declaration === undefined ? null : this.location(declaration),
            module: path.join("/"),
            functionType: checker
              .typeToString(checker.getTypeOfSymbol(functionType))
              .replace(/"/g, "") as FunctionType,
            // `ComponentApi` lists only the functions the parent may call.
            visibility: "public",
          });
        } else if (path.length < 4) {
          visit(propertyType, [...path, property.name]);
        }
      }
    };
    visit(checker.getTypeOfSymbol(instanceSymbol), []);
  }

  // ------------------------------------------------------------- resolvers

  private ownerOfDir(dir: string): Owner | null {
    const component = this.componentsByDir.get(dir);
    if (component !== undefined) {
      return { kind: "component", name: component.name, dir };
    }
    const app = this.appsByDir.get(dir);
    if (app !== undefined) {
      return { kind: "app", name: app.name, dir };
    }
    return null;
  }

  private componentFromRef(ownerDir: string, name: string): string | null {
    const component = this.componentsByDir.get(ownerDir);
    if (component !== undefined) {
      return component.children.get(name) ?? null;
    }
    return this.appsByDir.get(ownerDir)?.instances.get(name) ?? null;
  }

  private checkFunction(id: string): string | null {
    return this.functionIds.has(id) ? id : null;
  }

  private resolvers(): Analyzer["resolvers"] {
    return {
      functionFromRef: (ref: Extract<Val, { k: "ref" }>) => {
        const owner = this.ownerOfDir(ref.ownerDir);
        if (owner === null) {
          return null;
        }
        if (ref.root === "components") {
          if (ref.path.length < 3) {
            return null;
          }
          const component = this.componentFromRef(ref.ownerDir, ref.path[0]!);
          if (component === null) {
            return null;
          }
          const rest = ref.path.slice(1);
          return this.checkFunction(
            `fn:${component.slice("component:".length)}:${rest.slice(0, -1).join("/")}.${rest.at(-1)}`,
          );
        }
        if (ref.path.length < 2) {
          return null;
        }
        const prefix =
          owner.kind === "component"
            ? `fn:${owner.name}`
            : `fn:app:${owner.name}`;
        return this.checkFunction(
          `${prefix}:${ref.path.slice(0, -1).join("/")}.${ref.path.at(-1)}`,
        );
      },
      functionFromComponentApi: (dir: string, path: string[]) => {
        const component = this.componentsByDir.get(dir);
        if (component === undefined || path.length < 2) {
          return null;
        }
        return this.checkFunction(
          `fn:${component.name}:${path.slice(0, -1).join("/")}.${path.at(-1)}`,
        );
      },
      componentFromRef: (ownerDir, name) =>
        this.componentFromRef(ownerDir, name),
      componentPackage: (id: string) =>
        this.externalComponents.get(id)?.package ?? null,
      table: (owner: Owner, table: string) => {
        const id =
          owner.kind === "component"
            ? `table:${owner.name}.${table}`
            : `table:app:${owner.name}.${table}`;
        return this.tableIds.has(id) ? id : null;
      },
      envVar: (owner: Owner, name: string) => {
        const id =
          owner.kind === "component"
            ? `env:${owner.name}.${name}`
            : `env:app:${owner.name}.${name}`;
        return this.parts.has(id) ? id : null;
      },
      thirdParty: (host: string) => this.thirdPartyOfHost(host),
      thirdPartyOfLibraryFile: (fileName: string) =>
        this.thirdParties.find((t) =>
          (t.libraries ?? []).some((pkg) =>
            fileName.includes(`/node_modules/${pkg}/`),
          ),
        )?.id ?? null,
      partOfFunction: (node: ts.Node) => this.partOfFunction(node),
      onRoute: (route) => this.onRoute(route),
    };
  }

  private thirdPartyOfHost(host: string): string | null {
    const match = this.thirdParties.find((t) =>
      t.domains.some((d) => host === d || host.endsWith("." + d)),
    );
    if (match === undefined) {
      return null;
    }
    const part = this.parts.get(match.id) as Extract<
      ConvexPart,
      { kind: "thirdParty" }
    >;
    if (!part.hosts.includes(host)) {
      part.hosts.push(host);
      part.hosts.sort();
    }
    return match.id;
  }

  private onRoute({
    unit,
    call,
    path,
    method,
    handler,
  }: Parameters<Analyzer["resolvers"]["onRoute"]>[0]): void {
    const { analyzer } = this;
    const owner = unit.owner;
    const reportUnit = { ...unit, silent: false };
    if (owner === null || owner.kind !== "component") {
      analyzer.addUnresolved(
        reportUnit,
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
      const key = `${owner.name}|${handler.node.getSourceFile().fileName}|${handler.node.pos}`;
      handlerId = this.routesByHandler.get(key) ?? null;
      if (handlerId === null) {
        handlerId = `httpAction:${owner.name}:${paths.join("|")}`;
        this.routesByHandler.set(key, handlerId);
        this.addPart({
          kind: "function",
          id: handlerId,
          name: `httpAction ${paths.join(", ")}`,
          parent: `component:${owner.name}`,
          source: this.location(handler.node),
          module: "http",
          functionType: "httpAction",
          visibility: "public",
        });
        this.handlerWalks.push({
          node: handler.node,
          env: handler.env,
          unit: { from: handlerId, owner, app: undefined, mode: "server" },
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
        if (!this.parts.has(routeId)) {
          this.addPart({
            kind: "httpRoute",
            id: routeId,
            name: `${m} ${p}`,
            parent: `component:${owner.name}`,
            source: this.location(call),
            path: p,
            method: m,
          });
        }
        if (handlerId !== null) {
          this.addDependency("routesTo", routeId, handlerId, call);
        }
      }
    }
  }

  // ------------------------------------------------------------------ walks

  /**
   * Walk every registered function from the expression that defines it.
   * `onDefinition` sees each definition, for the project layer to relate it
   * to its own parts.
   */
  walkFunctions(
    onDefinition?: (definition: { expr: ts.Node; unit: Unit }) => void,
  ): void {
    for (const { exprs, unit } of this.functionDefinitions) {
      for (const { expr, env } of exprs) {
        if (expr !== undefined) {
          this.analyzer.walk(expr, env, unit);
          onDefinition?.({ expr, unit });
        }
      }
    }
  }

  /**
   * The HTTP routers of the components: a silent walk of each `http.ts` finds
   * the routes, then each handler is walked as a function of its own.
   */
  walkHttpRouters(): void {
    for (const component of this.components) {
      const httpFile = join(component.dir, "http.ts");
      if (!existsSync(httpFile)) {
        continue;
      }
      const owner: Owner = {
        kind: "component",
        name: component.name,
        dir: component.dir,
      };
      for (const statement of this.sourceFile(httpFile).statements) {
        this.analyzer.walk(statement, this.analyzer.rootEnv, {
          from: component.id,
          owner,
          app: undefined,
          mode: "server",
          silent: true,
        });
      }
    }
    for (const { node, env, unit } of this.handlerWalks) {
      this.analyzer.walkFunction({ k: "node", node, env }, env, unit, 0);
    }
  }

  /** What the components from npm fetch: `fetch("<literal URL>")` in their compiled code. */
  scanPackageFetches(): void {
    for (const [id, { configFiles }] of this.externalComponents) {
      const files = [...configFiles].sort().flatMap((f) =>
        readdirSync(dirname(f))
          .filter((name) => name.endsWith(".js"))
          .sort()
          .map((name) => join(dirname(f), name)),
      );
      for (const path of files) {
        const file = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
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
            const target = this.thirdPartyOfHost(host);
            if (target !== null) {
              const { line } = file.getLineAndCharacterOfPosition(
                node.getStart(file),
              );
              this.analyzer.addDependency(
                "fetches",
                id,
                target,
                [{ file: stablePath(this.root, path), line: line + 1 }],
                { via: host },
              );
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
  }

  // ------------------------------------------------------------------ model

  /** The model, sorted and checked: every parent and every endpoint exists. */
  model<
    P extends PartBase & { kind: string } = never,
    K extends string = never,
  >(project: string): StructureModel<P, K> {
    const parts = [...this.parts.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const { dependencies, unresolved } = this.analyzer.results();
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
        (a.app ?? "").localeCompare(b.app ?? ""),
    );
    unresolved.sort(
      (a, b) =>
        a.location.file.localeCompare(b.location.file) ||
        a.location.line - b.location.line ||
        a.kind.localeCompare(b.kind) ||
        a.reason.localeCompare(b.reason),
    );
    for (const part of parts) {
      if (part.parent !== null && !this.parts.has(part.parent)) {
        throw new Error(`${part.id}: no parent ${part.parent}`);
      }
    }
    for (const dependency of dependencies) {
      if (!this.parts.has(dependency.from) || !this.parts.has(dependency.to)) {
        throw new Error(
          `A dependency on a missing part: ${JSON.stringify(dependency)}`,
        );
      }
    }
    const count = (values: string[]) => {
      const out: Record<string, number> = {};
      for (const value of [...values].sort()) {
        out[value] = (out[value] ?? 0) + 1;
      }
      return out;
    };
    return {
      version: 2,
      project,
      parts,
      dependencies,
      unresolved,
      counts: {
        parts: count(parts.map((p) => p.kind)),
        dependencies: count(dependencies.map((d) => d.kind)),
        unresolved: count(unresolved.map((u) => u.kind)),
      },
    } as StructureModel<P, K>;
  }
}

// --------------------------------------------------------------- utilities

export function findCalls(
  file: ts.SourceFile,
  predicate: (call: ts.CallExpression) => boolean,
): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && predicate(node)) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

export function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : null;
}

const useCalls = (config: ts.SourceFile) =>
  findCalls(
    config,
    (c) =>
      calleeName(c) === "use" && ts.isPropertyAccessExpression(c.expression),
  );

const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** The name `defineComponent` gives a component, in the compiled file of its npm package. */
function packageComponentName(declarationFile: string): string {
  const jsFile = declarationFile.replace(/\.d\.ts$/, ".js");
  const match = /defineComponent\(\s*["']([^"']+)["']/.exec(
    readFileSync(jsFile, "utf8"),
  );
  if (match === null) {
    throw new Error(`No defineComponent in ${jsFile}`);
  }
  return match[1]!;
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

/** Whether a type is a registered Convex function, and which. */
export function registeredKind(
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
  const indexesType = checker.getTypeArguments(type as ts.TypeReference)[1];
  for (const index of indexesType === undefined
    ? []
    : indexesType.getProperties()) {
    const tuple = checker.getTypeOfSymbol(index);
    const names = checker
      .getTypeArguments(tuple as ts.TypeReference)
      .map((e) => checker.typeToString(e).replace(/"/g, ""));
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
  let type = checker
    .typeToString(
      checker.getTypeOfSymbol(typeProperty),
      undefined,
      ts.TypeFormatFlags.NoTruncation |
        ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
    )
    .replace(/'/g, '"');
  if (optional) {
    type = type.replace(/ \| undefined$/, "");
  }
  return { type, optional };
}
