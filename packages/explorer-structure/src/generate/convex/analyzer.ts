/**
 * The static analysis behind the dependencies: a small evaluator that follows
 * values through the source (constants, arguments, object properties, the
 * values functions return) and a walker that follows calls from a starting
 * expression and records what the code does along the way.
 *
 * Everything is resolved through the TypeScript type checker or through the
 * evaluator. A dependency it cannot pin down goes to the unresolved list with
 * the reason, never to a guess.
 *
 * @module
 */
import { dirname } from "node:path";
import ts from "typescript";
import type {
  Dependency,
  SourceLocation,
  Unresolved,
  UnresolvedKind,
} from "../../model.ts";
import { stablePath } from "./program.ts";

/** Who owns the code of a walk: the `_generated` directory its refs belong to. */
export type Owner =
  | { kind: "component"; name: string; dir: string }
  | { kind: "app"; name: string; dir: string };

/** A lexical environment: the arguments bound to the parameters of a call. */
export type Env = {
  id: number;
  bindings: Map<ts.Node, Bound>;
  parent: Env | null;
};

type Bound = { expr: ts.Node | undefined; env: Env };

export type Val =
  /** A syntax node (function, object literal, call, …) in the environment it was evaluated in. */
  | { k: "node"; node: ts.Node; env: Env }
  /** A path into a generated `api`, `internal`, or `components` object. */
  | {
      k: "ref";
      root: "api" | "internal" | "components";
      ownerDir: string;
      path: string[];
    }
  | { k: "str"; value: string }
  /** A property that a known object literal does not have. */
  | { k: "undef" };

export type Unit = {
  /** The part the walk records dependencies from. */
  from: string;
  owner: Owner | null;
  /**
   * The app a walk starts from, when it does: the walk carries that app's
   * arguments through the library code it calls.
   */
  app: string | undefined;
  /** Client code records the function references it calls; server code its `ctx` calls. */
  mode: "server" | "client";
  /** A walk that only looks for routes and records no dependencies. */
  silent?: boolean;
};

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
]);

type FunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
  return FUNCTION_LIKE.has(node.kind);
}

const CLIENT_REF_CALLS = new Set([
  "useQuery",
  "useMutation",
  "useAction",
  "usePaginatedQuery",
  "usePreloadedQuery",
  "preloadQuery",
  "fetchQuery",
  "fetchMutation",
  "fetchAction",
]);
const CLIENT_METHOD_CALLS = new Set(["query", "mutation", "action"]);
const DB_READS = new Set(["get", "query"]);
const DB_WRITES = new Set(["insert", "patch", "replace", "delete"]);

/** How deep the walker follows calls. Deeper than any chain in the source. */
const MAX_DEPTH = 30;

export type Resolvers = {
  /** The part id of a function a generated ref names, or null. */
  /**
   * The part id of the function a generated ref names, or null. `owner` is the
   * owner of the walk: code shared by several instances of a component (one
   * npm package mounted twice) resolves its refs for the instance walked.
   */
  functionFromRef(
    ref: Extract<Val, { k: "ref" }>,
    owner: Owner | null,
  ): string | null;
  /** The part id of a function named by a property of a `ComponentApi` type. */
  functionFromComponentApi(dir: string, path: string[]): string | null;
  /** The component a `components.<name>` ref names, from inside `ownerDir`. */
  componentFromRef(
    ownerDir: string,
    name: string,
    owner: Owner | null,
  ): string | null;
  /** The npm package of a component part, or null for one of this repository. */
  componentPackage(id: string): string | null;
  /** The part id of a table of the owner, or null. */
  table(owner: Owner, table: string): string | null;
  /** The part id of an env var of the owner, or null. */
  envVar(owner: Owner, name: string): string | null;
  /** The third party serving a host. */
  thirdParty(host: string): string | null;
  /** The third party a library file talks to, when one is configured. */
  thirdPartyOfLibraryFile(fileName: string): string | null;
  /** A function whose walk records under its own part (a hook, say), or null. */
  partOfFunction(node: ts.Node): string | null;
  /** Called for each `router.route({...})` a walk finds. */
  onRoute(route: {
    unit: Unit;
    call: ts.CallExpression;
    path: Val[];
    method: Val[];
    handler: { node: FunctionLike; env: Env } | null;
  }): void;
};

export class Analyzer {
  readonly checker: ts.TypeChecker;
  readonly rootEnv: Env = { id: 0, bindings: new Map(), parent: null };
  private nextEnvId = 1;
  private readonly dependencies = new Map<string, Dependency<string>>();
  private readonly unresolvedCandidates = new Map<string, Unresolved>();
  private readonly resolvedSites = new Set<string>();
  private readonly objectPropertiesByName = new Map<
    string,
    ts.ObjectLiteralElementLike[]
  >();
  resolvers!: Resolvers;

  constructor(
    readonly program: ts.Program,
    readonly root: string,
  ) {
    this.checker = program.getTypeChecker();
  }

  // ---------------------------------------------------------------- output

  location(node: ts.Node): SourceLocation {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { file: stablePath(this.root, file.fileName), line: line + 1 };
  }

  addDependency(
    kind: string,
    from: string,
    to: string,
    evidence: SourceLocation[],
    extra: { via?: string; app?: string } = {},
  ): void {
    const key = [kind, from, to, extra.app ?? ""].join("|");
    let dependency = this.dependencies.get(key);
    if (dependency === undefined) {
      dependency = { kind, from, to, evidence: [] };
      if (extra.app !== undefined) {
        dependency.app = extra.app;
      }
      this.dependencies.set(key, dependency);
    }
    for (const location of evidence) {
      if (
        !dependency.evidence.some(
          (e) => e.file === location.file && e.line === location.line,
        )
      ) {
        dependency.evidence.push(location);
      }
    }
    if (extra.via !== undefined) {
      dependency.via ??= [];
      if (!dependency.via.includes(extra.via)) {
        dependency.via.push(extra.via);
      }
    }
  }

  private emit(
    unit: Unit,
    kind: string,
    to: string,
    evidence: SourceLocation[],
    extra: { via?: string; app?: string } = {},
  ): void {
    if (!unit.silent) {
      this.addDependency(kind, unit.from, to, evidence, extra);
    }
  }

  private siteKey(node: ts.Node): string {
    return `${node.getSourceFile().fileName}:${node.getStart()}`;
  }

  /**
   * Mark a site resolved. A site that any walk resolves leaves the unresolved
   * list: it is unresolved only where an app passes nothing to resolve it by.
   */
  private resolved(node: ts.Node): void {
    this.resolvedSites.add(this.siteKey(node));
  }

  addUnresolved(
    unit: Unit,
    kind: UnresolvedKind,
    node: ts.Node,
    reason: string,
  ): void {
    if (unit.silent) {
      return;
    }
    const key = `${this.siteKey(node)}|${kind}|${reason}`;
    let entry = this.unresolvedCandidates.get(key);
    if (entry === undefined) {
      const text = node.getText().replace(/\s+/g, " ");
      entry = {
        kind,
        location: this.location(node),
        code: text.length > 100 ? text.slice(0, 97) + "..." : text,
        reason,
        from: [],
      };
      this.unresolvedCandidates.set(key, entry);
    }
    if (!entry.from.includes(unit.from)) {
      entry.from.push(unit.from);
      entry.from.sort();
    }
  }

  results(): { dependencies: Dependency<string>[]; unresolved: Unresolved[] } {
    const unresolved = [...this.unresolvedCandidates.entries()]
      .filter(
        ([key]) => !this.resolvedSites.has(key.slice(0, key.indexOf("|"))),
      )
      .map(([, value]) => value);
    return { dependencies: [...this.dependencies.values()], unresolved };
  }

  // ------------------------------------------------------------- evaluator

  childEnv(parent: Env): Env {
    return { id: this.nextEnvId++, bindings: new Map(), parent };
  }

  private lookup(env: Env, node: ts.Node): Bound | undefined {
    for (let e: Env | null = env; e !== null; e = e.parent) {
      const bound = e.bindings.get(node);
      if (bound !== undefined) {
        return bound;
      }
    }
    return undefined;
  }

  symbolAt(node: ts.Node): ts.Symbol | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  }

  /** Whether a declaration comes from a library: a `.d.ts` or a file of an npm package. */
  isExternal(node: ts.Node): boolean {
    const fileName = node.getSourceFile().fileName;
    return fileName.endsWith(".d.ts") || fileName.includes("/node_modules/");
  }

  private generatedRoot(
    declaration: ts.Node,
    name: string,
  ): Extract<Val, { k: "ref" }> | null {
    const fileName = declaration.getSourceFile().fileName;
    if (
      // A `_generated/api` of an npm package names that package's functions;
      // the resolvers know it when the project reads its source.
      !/\/_generated\/api\.(ts|js|d\.ts)$/.test(fileName) ||
      (name !== "api" && name !== "internal" && name !== "components")
    ) {
      return null;
    }
    return {
      k: "ref",
      root: name,
      ownerDir: dirname(dirname(fileName)),
      path: [],
    };
  }

  /** The value of the root of a declaration at module level, or in the current env. */
  private envFor(declaration: ts.Node, env: Env): Env {
    for (
      let node = declaration.parent;
      node !== undefined;
      node = node.parent
    ) {
      if (isFunctionLike(node)) {
        return env;
      }
    }
    return this.rootEnv;
  }

  evaluate(expr: ts.Node | undefined, env: Env, depth = 0): Val[] {
    if (expr === undefined) {
      return [{ k: "undef" }];
    }
    if (depth > 40) {
      return [];
    }
    const next = depth + 1;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isAwaitExpression(expr)
    ) {
      return this.evaluate(expr.expression, env, next);
    }
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return [{ k: "str", value: expr.text }];
    }
    if (ts.isTemplateExpression(expr)) {
      let values = [expr.head.text];
      for (const span of expr.templateSpans) {
        const parts = this.evaluate(span.expression, env, next);
        if (parts.length === 0 || parts.some((p) => p.k !== "str")) {
          return [];
        }
        values = values.flatMap((prefix) =>
          parts.map(
            (p) => prefix + (p as { value: string }).value + span.literal.text,
          ),
        );
      }
      return values.map((value) => ({ k: "str", value }));
    }
    if (ts.isIdentifier(expr)) {
      return this.evaluateIdentifier(expr, env, next);
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return this.evaluate(expr.expression, env, next).flatMap((value) =>
        this.property(value, expr.name.text, next),
      );
    }
    if (ts.isElementAccessExpression(expr)) {
      const keys = this.evaluate(expr.argumentExpression, env, next);
      if (keys.length !== 1 || keys[0]!.k !== "str") {
        return [];
      }
      const key = keys[0].value;
      return this.evaluate(expr.expression, env, next).flatMap((value) =>
        this.property(value, key, next),
      );
    }
    if (ts.isCallExpression(expr)) {
      return this.evaluateCall(expr, env, next);
    }
    if (ts.isConditionalExpression(expr)) {
      return [
        ...this.evaluate(expr.whenTrue, env, next),
        ...this.evaluate(expr.whenFalse, env, next),
      ];
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        const left = this.evaluate(expr.left, env, next);
        if (left.length > 0 && left.every((v) => v.k === "undef")) {
          return this.evaluate(expr.right, env, next);
        }
        if (left.length > 0 && left.every((v) => v.k !== "undef")) {
          return left;
        }
        return [];
      }
      return [];
    }
    if (
      ts.isObjectLiteralExpression(expr) ||
      ts.isArrayLiteralExpression(expr) ||
      ts.isNewExpression(expr) ||
      ts.isJsxAttributes(expr) ||
      isFunctionLike(expr) ||
      ts.isClassDeclaration(expr)
    ) {
      return [{ k: "node", node: expr, env }];
    }
    return [];
  }

  private evaluateIdentifier(
    expr: ts.Identifier,
    env: Env,
    depth: number,
  ): Val[] {
    if (expr.text === "undefined") {
      return [{ k: "undef" }];
    }
    const parent = expr.parent;
    const raw =
      parent !== undefined &&
      ts.isShorthandPropertyAssignment(parent) &&
      parent.name === expr
        ? this.checker.getShorthandAssignmentValueSymbol(parent)
        : this.checker.getSymbolAtLocation(expr);
    if (raw === undefined) {
      return [];
    }
    let symbol = raw;
    if (raw.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = this.checker.getAliasedSymbol(raw);
      } catch {
        return [];
      }
    }
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration === undefined) {
      return [];
    }
    const generated = this.generatedRoot(declaration, symbol.name);
    if (generated !== null) {
      return [generated];
    }
    return this.evaluateDeclaration(declaration, env, depth);
  }

  private evaluateDeclaration(
    declaration: ts.Node,
    env: Env,
    depth: number,
  ): Val[] {
    if (ts.isParameter(declaration)) {
      const bound = this.lookup(env, declaration);
      if (bound === undefined) {
        return [];
      }
      const values = this.evaluate(bound.expr, bound.env, depth);
      if (
        declaration.initializer !== undefined &&
        values.every((v) => v.k === "undef")
      ) {
        return this.evaluate(declaration.initializer, env, depth);
      }
      return values;
    }
    if (ts.isVariableDeclaration(declaration)) {
      const statement = declaration.parent?.parent;
      if (statement !== undefined && ts.isForOfStatement(statement)) {
        return this.evaluate(statement.expression, env, depth).flatMap(
          (value) =>
            value.k === "node" && ts.isArrayLiteralExpression(value.node)
              ? value.node.elements.flatMap((element) =>
                  this.evaluate(element, value.env, depth),
                )
              : [],
        );
      }
      const list = declaration.parent;
      if (
        !ts.isVariableDeclarationList(list) ||
        !(list.flags & ts.NodeFlags.Const) ||
        declaration.initializer === undefined ||
        !ts.isIdentifier(declaration.name)
      ) {
        return [];
      }
      return this.evaluate(
        declaration.initializer,
        this.envFor(declaration, env),
        depth,
      );
    }
    if (ts.isBindingElement(declaration)) {
      return this.evaluateBindingElement(declaration, env, depth).flatMap(
        ({ expr, env: e }) => this.evaluate(expr, e, depth),
      );
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return this.evaluate(declaration.name, env, depth);
    }
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
    ) {
      if (this.isExternal(declaration)) {
        return [];
      }
      return [
        { k: "node", node: declaration, env: this.envFor(declaration, env) },
      ];
    }
    return [];
  }

  /** The (unevaluated) expressions a destructured name is taken from. */
  evaluateBindingElement(
    element: ts.BindingElement,
    env: Env,
    depth = 0,
  ): { expr: ts.Node | undefined; env: Env }[] {
    const pattern = element.parent;
    if (!ts.isObjectBindingPattern(pattern)) {
      return [];
    }
    const keyNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(keyNode) && !ts.isStringLiteral(keyNode)) {
      return [];
    }
    const key = keyNode.text;
    const holder = pattern.parent;
    let sources: Val[];
    if (ts.isBindingElement(holder)) {
      sources = this.evaluateBindingElement(holder, env, depth + 1).flatMap(
        ({ expr, env: e }) => this.evaluate(expr, e, depth + 1),
      );
    } else if (ts.isVariableDeclaration(holder)) {
      sources = this.evaluate(
        holder.initializer,
        this.envFor(holder, env),
        depth + 1,
      );
    } else if (ts.isParameter(holder)) {
      const bound = this.lookup(env, holder);
      sources =
        bound === undefined
          ? []
          : this.evaluate(bound.expr, bound.env, depth + 1);
    } else {
      sources = [];
    }
    return sources.flatMap((source) =>
      this.propertyExpressions(source, key, depth + 1),
    );
  }

  /** The expressions that give a property of a value, unevaluated. */
  propertyExpressions(
    value: Val,
    name: string,
    depth = 0,
  ): { expr: ts.Node | undefined; env: Env }[] {
    if (value.k !== "node") {
      return [];
    }
    const { node, env } = value;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of [...node.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) {
          const fromSpread = this.evaluate(
            property.expression,
            env,
            depth + 1,
          ).flatMap((spread) =>
            this.propertyExpressions(spread, name, depth + 1),
          );
          if (fromSpread.length > 0) {
            return fromSpread;
          }
          continue;
        }
        if (
          property.name === undefined ||
          propertyNameText(property.name) !== name
        ) {
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          return [{ expr: property.initializer, env }];
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return [{ expr: property.name, env }];
        }
        if (ts.isMethodDeclaration(property)) {
          return [{ expr: property, env }];
        }
        return [];
      }
      return [{ expr: undefined, env }];
    }
    if (ts.isJsxAttributes(node)) {
      for (const attribute of node.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          ts.isIdentifier(attribute.name) &&
          attribute.name.text === name
        ) {
          const init = attribute.initializer;
          if (init === undefined) {
            return [];
          }
          if (ts.isJsxExpression(init)) {
            return [{ expr: init.expression, env }];
          }
          return [{ expr: init, env }];
        }
      }
      return [{ expr: undefined, env }];
    }
    return [];
  }

  /**
   * The syntax that defines a value: follows bound parameters, constants, and
   * properties of known object literals, and stops at the first expression it
   * cannot see through (a call, a property of an unknown object, …).
   */
  trace(
    expr: ts.Node | undefined,
    env: Env,
    depth = 0,
  ): { expr: ts.Node | undefined; env: Env }[] {
    if (expr === undefined || depth > 40) {
      return [{ expr, env }];
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      return this.trace(expr.expression, env, depth + 1);
    }
    if (ts.isIdentifier(expr)) {
      const parent = expr.parent;
      let symbol =
        parent !== undefined &&
        ts.isShorthandPropertyAssignment(parent) &&
        parent.name === expr
          ? this.checker.getShorthandAssignmentValueSymbol(parent)
          : this.checker.getSymbolAtLocation(expr);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = this.checker.getAliasedSymbol(symbol);
      }
      const declaration = symbol?.valueDeclaration;
      if (declaration === undefined || this.isExternal(declaration)) {
        return [{ expr, env }];
      }
      if (ts.isParameter(declaration)) {
        const bound = this.lookup(env, declaration);
        return bound === undefined
          ? [{ expr, env }]
          : this.trace(bound.expr, bound.env, depth + 1);
      }
      if (
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
      ) {
        return this.trace(
          declaration.initializer,
          this.envFor(declaration, env),
          depth + 1,
        );
      }
      if (ts.isBindingElement(declaration)) {
        const sources = this.evaluateBindingElement(
          declaration,
          env,
          depth + 1,
        );
        return sources.length === 0
          ? [{ expr, env }]
          : sources.flatMap((s) => this.trace(s.expr, s.env, depth + 1));
      }
      return [{ expr, env }];
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const holders = this.evaluate(expr.expression, env, depth + 1).filter(
        (v) => v.k === "node",
      );
      const found = holders.flatMap((holder) =>
        this.propertyExpressions(holder, expr.name.text, depth + 1),
      );
      return found.length === 0
        ? [{ expr, env }]
        : found.flatMap((f) => this.trace(f.expr, f.env, depth + 1));
    }
    return [{ expr, env }];
  }

  property(value: Val, name: string, depth = 0): Val[] {
    if (value.k === "ref") {
      return [{ ...value, path: [...value.path, name] }];
    }
    return this.propertyExpressions(value, name, depth).flatMap(
      ({ expr, env }) => this.evaluate(expr, env, depth + 1),
    );
  }

  /** Bind the parameters of a function to the arguments of a call. */
  bindCall(
    fn: Extract<Val, { k: "node" }>,
    args: readonly ts.Node[],
    callerEnv: Env,
  ): Env {
    const env = this.childEnv(fn.env);
    const node = fn.node as FunctionLike;
    node.parameters?.forEach((parameter, index) => {
      if (parameter.dotDotDotToken === undefined) {
        env.bindings.set(parameter, { expr: args[index], env: callerEnv });
      }
    });
    return env;
  }

  private evaluateCall(
    call: ts.CallExpression,
    env: Env,
    depth: number,
  ): Val[] {
    const reactHook = this.reactMemoHook(call);
    if (reactHook === "useCallback") {
      return this.evaluate(call.arguments[0], env, depth + 1);
    }
    if (reactHook === "useMemo") {
      return this.evaluate(call.arguments[0], env, depth + 1).flatMap((fn) =>
        fn.k === "node" && isFunctionLike(fn.node)
          ? returnExpressions(fn.node).flatMap((expr) =>
              this.evaluate(expr, this.bindCall(fn, [], env), depth + 1),
            )
          : [],
      );
    }
    const { functions } = this.resolveCallee(call.expression, env, depth);
    return functions.flatMap((fn) => {
      const callEnv = this.bindCall(fn, call.arguments, env);
      return returnExpressions(fn.node as FunctionLike).flatMap((expr) =>
        this.evaluate(expr, callEnv, depth + 1),
      );
    });
  }

  /** React's `useCallback(fn)` returns `fn`, and `useMemo(f)` what `f` returns. */
  private reactMemoHook(
    call: ts.CallExpression,
  ): "useCallback" | "useMemo" | null {
    const callee = call.expression;
    const name = ts.isIdentifier(callee)
      ? callee
      : ts.isPropertyAccessExpression(callee)
        ? callee.name
        : null;
    if (
      name === null ||
      (name.text !== "useCallback" && name.text !== "useMemo")
    ) {
      return null;
    }
    const declaration = this.symbolAt(name)?.declarations?.[0];
    if (
      declaration === undefined ||
      !/\/@types\/react\//.test(declaration.getSourceFile().fileName)
    ) {
      return null;
    }
    return name.text;
  }

  /**
   * The functions a callee can be. `external` is true when it is declared by
   * a library, where the walk stops.
   */
  resolveCallee(
    callee: ts.Expression,
    env: Env,
    depth = 0,
  ): { functions: Extract<Val, { k: "node" }>[]; external: boolean } {
    const values = this.evaluate(callee, env, depth).filter(
      (v): v is Extract<Val, { k: "node" }> =>
        v.k === "node" && isFunctionLike(v.node),
    );
    if (values.length > 0) {
      return { functions: values, external: false };
    }
    const nameNode = ts.isPropertyAccessExpression(callee)
      ? callee.name
      : callee;
    const symbol = this.symbolAt(nameNode);
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0) {
      return { functions: [], external: false };
    }
    if (declarations.every((d) => this.isExternal(d))) {
      return { functions: [], external: true };
    }
    const functions: Extract<Val, { k: "node" }>[] = [];
    for (const declaration of declarations) {
      if (this.isExternal(declaration)) {
        continue;
      }
      if (isFunctionLike(declaration)) {
        functions.push({
          k: "node",
          node: declaration,
          env: this.envFor(declaration, env),
        });
      } else if (
        ts.isPropertySignature(declaration) ||
        ts.isMethodSignature(declaration)
      ) {
        functions.push(...this.implementationsOf(declaration, depth));
      } else if (ts.isBindingElement(declaration)) {
        functions.push(...this.bindingElementByType(declaration, depth));
      } else if (
        ts.isPropertyAssignment(declaration) ||
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration)
      ) {
        const init = declaration.initializer;
        if (init !== undefined) {
          functions.push(
            ...this.evaluate(
              init,
              this.envFor(declaration, env),
              depth + 1,
            ).filter(
              (v): v is Extract<Val, { k: "node" }> =>
                v.k === "node" && isFunctionLike(v.node),
            ),
          );
        }
      }
    }
    return { functions, external: false };
  }

  /**
   * A destructured name whose source the evaluator cannot follow: the
   * property of the source's type names a declaration, which may be an
   * interface member with a unique implementation.
   */
  private bindingElementByType(
    element: ts.BindingElement,
    depth: number,
  ): Extract<Val, { k: "node" }>[] {
    const pattern = element.parent;
    const holder = pattern.parent;
    const keyNode = element.propertyName ?? element.name;
    if (
      !ts.isIdentifier(keyNode) ||
      !ts.isVariableDeclaration(holder) ||
      holder.initializer === undefined
    ) {
      return [];
    }
    const type = this.checker.getTypeAtLocation(holder.initializer);
    const property = type.getProperty(keyNode.text);
    const out: Extract<Val, { k: "node" }>[] = [];
    for (const declaration of property?.declarations ?? []) {
      if (
        ts.isPropertySignature(declaration) ||
        ts.isMethodSignature(declaration)
      ) {
        out.push(...this.implementationsOf(declaration, depth));
      }
    }
    return out;
  }

  private objectPropertiesNamed(name: string): ts.ObjectLiteralElementLike[] {
    if (this.objectPropertiesByName.size === 0) {
      for (const file of this.program.getSourceFiles()) {
        if (
          file.isDeclarationFile ||
          file.fileName.includes("/node_modules/")
        ) {
          continue;
        }
        const visit = (node: ts.Node) => {
          if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
              if (property.name !== undefined) {
                const key = propertyNameText(property.name);
                if (key !== null) {
                  const list = this.objectPropertiesByName.get(key) ?? [];
                  list.push(property);
                  this.objectPropertiesByName.set(key, list);
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
    return this.objectPropertiesByName.get(name) ?? [];
  }

  /**
   * The implementation of an interface member: the object literal property,
   * among all of the source, whose contextual type names this member. Only a
   * unique implementation counts.
   */
  private implementationsOf(
    member: ts.PropertySignature | ts.MethodSignature,
    depth: number,
  ): Extract<Val, { k: "node" }>[] {
    const name =
      member.name !== undefined ? propertyNameText(member.name) : null;
    if (name === null) {
      return [];
    }
    const matches: ts.ObjectLiteralElementLike[] = [];
    for (const property of this.objectPropertiesNamed(name)) {
      const contextual = this.checker.getContextualType(
        property.parent as ts.ObjectLiteralExpression,
      );
      const memberSymbol = contextual?.getProperty(name);
      if (memberSymbol?.declarations?.includes(member)) {
        matches.push(property);
      }
    }
    if (matches.length !== 1) {
      return [];
    }
    const property = matches[0]!;
    let expr: ts.Node;
    if (ts.isPropertyAssignment(property)) {
      expr = property.initializer;
    } else if (ts.isShorthandPropertyAssignment(property)) {
      expr = property.name;
    } else {
      expr = property;
    }
    return this.evaluate(
      expr,
      this.envFor(property, this.rootEnv),
      depth + 1,
    ).filter(
      (v): v is Extract<Val, { k: "node" }> =>
        v.k === "node" && isFunctionLike(v.node),
    );
  }

  // ---------------------------------------------------------------- walker

  private readonly walked = new Set<string>();

  /** Walk an expression or statement in a unit. */
  walk(node: ts.Node, env: Env, unit: Unit, depth = 0): void {
    if (depth > MAX_DEPTH) {
      return;
    }
    const visit = (child: ts.Node): void => {
      if (isFunctionLike(child)) {
        // A closure handed to code the walk cannot follow runs there. Walk it
        // where it stands, with its own parameters unbound. Any other closure
        // is a value, walked when the walk sees it called.
        if (this.runsWhereItStands(child, env)) {
          this.walkFunction(
            { k: "node", node: child, env },
            this.childEnv(env),
            unit,
            depth + 1,
          );
        }
        return;
      }
      if (ts.isCallExpression(child)) {
        this.handleCall(child, env, unit, depth);
      } else if (
        ts.isJsxSelfClosingElement(child) ||
        ts.isJsxOpeningElement(child)
      ) {
        this.handleJsx(child, env, unit, depth);
      } else if (ts.isPropertyAccessExpression(child)) {
        this.handlePropertyAccess(child, env, unit);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }

  /**
   * Whether a closure is handed, directly or inside object and array
   * literals, to a callee the walk cannot follow: a library function, a
   * constructor, an unresolved callee, or JSX.
   */
  private runsWhereItStands(fn: ts.Node, env: Env): boolean {
    let node: ts.Node = fn;
    let parent = fn.parent;
    while (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isConditionalExpression(parent) ||
        (ts.isBinaryExpression(parent) && parent.right === node))
    ) {
      node = parent;
      parent = parent.parent;
    }
    if (parent === undefined) {
      return false;
    }
    if (ts.isJsxExpression(parent) || ts.isNewExpression(parent)) {
      return true;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(node as ts.Expression)
    ) {
      return this.resolveCallee(parent.expression, env).functions.length === 0;
    }
    return false;
  }

  /**
   * Walk every function of a module where it stands, and its top-level
   * statements: what the module's code can do, whoever calls it.
   */
  walkModule(file: ts.SourceFile, unit: Unit): void {
    // Every function of the module, at any depth: a closure the module
    // returns runs wherever its caller calls it.
    const visit = (node: ts.Node) => {
      if (isFunctionLike(node) || ts.isConstructorDeclaration(node)) {
        if (node.body !== undefined) {
          const part = this.resolvers.partOfFunction(node);
          this.walk(
            node.body,
            this.childEnv(this.rootEnv),
            part === null ? unit : { ...unit, from: part },
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const statement of file.statements) {
      if (
        ts.isExpressionStatement(statement) ||
        ts.isExportAssignment(statement)
      ) {
        this.walk(statement, this.rootEnv, unit);
      }
      visit(statement);
    }
  }

  /** Walk the body of a function under an env that binds its parameters. */
  walkFunction(
    fn: Extract<Val, { k: "node" }>,
    env: Env,
    unit: Unit,
    depth: number,
  ): void {
    const node = fn.node as FunctionLike;
    const key = `${unit.from}|${unit.app ?? ""}|${node.getSourceFile().fileName}:${node.pos}|${env.id}`;
    if (this.walked.has(key) || depth > MAX_DEPTH) {
      return;
    }
    // A function walked more than a few times in one unit adds nothing new.
    const shallowKey = `${unit.from}|${unit.app ?? ""}|${node.getSourceFile().fileName}:${node.pos}`;
    const count = this.walkCounts.get(shallowKey) ?? 0;
    if (count >= 12) {
      return;
    }
    this.walkCounts.set(shallowKey, count + 1);
    this.walked.add(key);
    const part = this.resolvers.partOfFunction(node);
    const inner =
      part !== null && part !== unit.from ? { ...unit, from: part } : unit;
    for (const parameter of node.parameters) {
      if (parameter.initializer !== undefined) {
        this.walk(parameter.initializer, env, inner, depth);
      }
    }
    if (node.body !== undefined) {
      this.walk(node.body, env, inner, depth);
    }
  }

  private readonly walkCounts = new Map<string, number>();

  private handleJsx(
    element: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
    env: Env,
    unit: Unit,
    depth: number,
  ): void {
    const { functions } = this.resolveCallee(
      element.tagName as ts.Expression,
      env,
    );
    for (const fn of functions) {
      this.walkFunction(
        fn,
        this.bindCall(fn, [element.attributes], env),
        unit,
        depth + 1,
      );
    }
  }

  private handlePropertyAccess(
    access: ts.PropertyAccessExpression,
    env: Env,
    unit: Unit,
  ): void {
    const parent = access.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === access) {
      return;
    }
    // `env.NAME`, where `env` is the one `_generated/server` exports.
    if (
      ts.isIdentifier(access.expression) &&
      access.expression.text === "env" &&
      unit.owner !== null
    ) {
      const declaration = this.symbolAt(access.expression)?.declarations?.[0];
      if (
        declaration !== undefined &&
        /\/_generated\/server\.(ts|js|d\.ts)$/.test(
          declaration.getSourceFile().fileName,
        )
      ) {
        const id = this.resolvers.envVar(unit.owner, access.name.text);
        if (id !== null) {
          this.emit(unit, "readsEnv", id, [this.location(access)], {
            app: unit.app,
          });
        }
      }
      return;
    }
    if (this.consumed.has(access)) {
      return;
    }
    const values = this.evaluate(access, env);
    for (const value of values) {
      if (value.k !== "ref") {
        continue;
      }
      const target = this.resolvers.functionFromRef(value, unit.owner);
      if (target !== null) {
        this.emit(unit, "referencesFunction", target, [this.location(access)], {
          app: unit.app,
        });
      }
    }
  }

  private readonly consumed = new Set<ts.Node>();

  /** The function a reference names: through the evaluator, then through its type. */
  private resolveFunctionRef(
    expr: ts.Expression,
    env: Env,
    unit: Unit,
  ): string[] | null {
    const values = this.evaluate(expr, env);
    const targets = new Set<string>();
    let unknown = values.length === 0;
    for (const value of values) {
      const target =
        value.k === "ref"
          ? this.resolvers.functionFromRef(value, unit.owner)
          : null;
      if (target === null) {
        unknown = true;
      } else {
        targets.add(target);
      }
    }
    if (!unknown) {
      return [...targets];
    }
    // The reference may come through an argument the walk does not know.
    // Where it was written, its type may still name the component function.
    const traced = this.trace(expr, env);
    const byType = traced.map(({ expr: e }) =>
      e !== undefined && ts.isExpression(e)
        ? this.functionFromComponentApiType(e)
        : null,
    );
    if (byType.length > 0 && byType.every((t) => t !== null)) {
      return [...new Set(byType as string[])];
    }
    return null;
  }

  /**
   * A reference to a component function, typed by the `ComponentApi` that
   * `_generated/component.ts` of the component declares: the property's
   * declaration sits in that file, and the type literals around it give its
   * path.
   */
  private functionFromComponentApiType(expr: ts.Expression): string | null {
    let inner: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner)
    ) {
      inner = inner.expression;
    }
    if (!ts.isPropertyAccessExpression(inner)) {
      return null;
    }
    const symbol = this.checker.getSymbolAtLocation(inner.name);
    const declaration = symbol?.declarations?.[0];
    if (declaration === undefined || !ts.isPropertySignature(declaration)) {
      return null;
    }
    const fileName = declaration.getSourceFile().fileName;
    if (
      !/\/_generated\/component\.ts$/.test(fileName) ||
      fileName.includes("/node_modules/")
    ) {
      return null;
    }
    const path: string[] = [];
    for (
      let node: ts.Node | undefined = declaration;
      node !== undefined;
      node = node.parent
    ) {
      if (ts.isPropertySignature(node) && node.name !== undefined) {
        const key = propertyNameText(node.name);
        if (key === null) {
          return null;
        }
        path.unshift(key);
      }
      if (ts.isTypeAliasDeclaration(node)) {
        break;
      }
    }
    return this.resolvers.functionFromComponentApi(
      dirname(dirname(fileName)),
      path,
    );
  }

  private handleCall(
    call: ts.CallExpression,
    env: Env,
    unit: Unit,
    depth: number,
  ): void {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // A dynamic `import()` loads a module; it calls no function.
      return;
    }
    let callee: ts.Expression = call.expression;
    // `(ctx.runQuery as (...) => ...)(ref)` calls `ctx.runQuery`.
    while (
      ts.isParenthesizedExpression(callee) ||
      ts.isAsExpression(callee) ||
      ts.isNonNullExpression(callee)
    ) {
      callee = callee.expression;
    }
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;
    const args = call.arguments;
    const receiver = ts.isPropertyAccessExpression(callee)
      ? callee.expression
      : null;
    const receiverName =
      receiver !== null && ts.isPropertyAccessExpression(receiver)
        ? receiver.name.text
        : receiver !== null && ts.isIdentifier(receiver)
          ? receiver.text
          : null;

    // ctx.runQuery / runMutation / runAction
    if (
      unit.mode === "server" &&
      receiver !== null &&
      (name === "runQuery" || name === "runMutation" || name === "runAction") &&
      args.length > 0
    ) {
      this.recordFunctionCall("calls", call, args[0]!, env, unit, name);
      return;
    }
    // ctx.scheduler.runAfter / runAt
    if (
      unit.mode === "server" &&
      receiverName === "scheduler" &&
      (name === "runAfter" || name === "runAt") &&
      args.length > 1
    ) {
      this.recordFunctionCall("schedules", call, args[1]!, env, unit, name);
      return;
    }
    // ctx.db.<op>
    if (
      receiverName === "db" &&
      name !== null &&
      (DB_READS.has(name) || DB_WRITES.has(name))
    ) {
      this.recordTableAccess(call, name, env, unit);
      return;
    }
    // fetch(url)
    if (ts.isIdentifier(callee) && name === "fetch") {
      const declaration = this.symbolAt(callee)?.declarations?.[0];
      if (declaration !== undefined && this.isExternal(declaration)) {
        this.recordFetch(call, env, unit);
        return;
      }
    }
    // Client calls of function references.
    if (
      unit.mode === "client" &&
      args.length > 0 &&
      name !== null &&
      ((ts.isIdentifier(callee) && CLIENT_REF_CALLS.has(name)) ||
        (receiver !== null && CLIENT_METHOD_CALLS.has(name)))
    ) {
      this.recordClientCall(call, args[0]!, env, unit);
    }
    // A child component called through its client library.
    this.recordChildComponentCall(call, env, unit);

    const { functions, external } = this.resolveCallee(callee, env);
    const declarations =
      this.symbolAt(
        ts.isPropertyAccessExpression(callee) ? callee.name : callee,
      )?.declarations ?? [];
    // A call into a library that talks to a third party (a WebAuthn
    // ceremony, an SDK).
    for (const declaration of declarations) {
      const thirdParty = this.resolvers.thirdPartyOfLibraryFile(
        declaration.getSourceFile().fileName,
      );
      if (thirdParty !== null) {
        this.emit(unit, "callsThirdParty", thirdParty, [this.location(call)], {
          via: name ?? undefined,
          app: unit.app,
        });
        break;
      }
    }
    // router.route({ path, method, handler })
    if (
      name === "route" &&
      receiver !== null &&
      external &&
      args.length === 1
    ) {
      const type = this.checker.getTypeAtLocation(receiver);
      if (
        type.getSymbol()?.name === "HttpRouter" ||
        type.aliasSymbol?.name === "HttpRouter"
      ) {
        this.recordRoute(call, env, unit);
      }
    }
    if (functions.length > 0) {
      this.resolved(call);
      for (const fn of functions) {
        this.walkFunction(fn, this.bindCall(fn, args, env), unit, depth + 1);
      }
    } else if (!external) {
      // A callee whose type a library declares (a React state setter, a
      // timer) runs no code of this repository.
      const signatures = this.checker
        .getTypeAtLocation(callee)
        .getCallSignatures();
      if (
        signatures.length > 0 &&
        signatures.every(
          (sig) =>
            sig.declaration !== undefined && this.isExternal(sig.declaration),
        )
      ) {
        return;
      }
      const symbol = this.symbolAt(
        ts.isPropertyAccessExpression(callee) ? callee.name : callee,
      );
      const declaration = symbol?.declarations?.[0];
      let reason = "The callee is a value the analysis cannot trace";
      if (
        declaration !== undefined &&
        (ts.isParameter(declaration) || ts.isBindingElement(declaration))
      ) {
        reason =
          "The callee is a parameter, or comes from one, and the walk does not know its argument";
      } else if (
        declaration !== undefined &&
        (ts.isPropertySignature(declaration) ||
          ts.isMethodSignature(declaration))
      ) {
        reason =
          "The callee is a member of a type that has no single implementation the analysis can find";
      }
      this.addUnresolved(unit, "call", call, reason);
    }
  }

  private recordFunctionCall(
    kind: "calls" | "schedules",
    call: ts.CallExpression,
    refExpr: ts.Expression,
    env: Env,
    unit: Unit,
    via: string,
  ): void {
    this.consumed.add(refExpr);
    const targets = this.resolveFunctionRef(refExpr, env, unit);
    if (targets === null) {
      const isHandle = [
        { expr: refExpr as ts.Node | undefined },
        ...this.trace(refExpr, env),
      ].some(({ expr: e }) => {
        if (e === undefined) {
          return false;
        }
        const type = this.checker.getTypeAtLocation(e);
        return (
          /FunctionHandle/.test(this.checker.typeToString(type)) ||
          (type.isIntersection() &&
            type.types.some((t) => t.flags & ts.TypeFlags.String))
        );
      });
      const fromParameter = this.trace(refExpr, env).some(({ expr: e }) => {
        if (e === undefined || !ts.isIdentifier(e)) {
          return false;
        }
        const declaration = this.symbolAt(e)?.valueDeclaration;
        return declaration !== undefined && ts.isParameter(declaration);
      });
      const reason = isHandle
        ? "A function handle, which names a function only at run time"
        : fromParameter
          ? "The reference is a parameter: the code forwards whatever reference its caller passes"
          : "The function reference is not one the analysis can trace to a function";
      this.addUnresolved(unit, "functionReference", call, reason);
      return;
    }
    this.resolved(call);
    for (const target of targets) {
      this.emit(unit, kind, target, [this.location(call)], {
        via,
        app: unit.app,
      });
    }
  }

  private recordClientCall(
    call: ts.CallExpression,
    refExpr: ts.Expression,
    env: Env,
    unit: Unit,
  ): void {
    this.consumed.add(refExpr);
    const values = this.evaluate(refExpr, env);
    const refs = values.filter(
      (v): v is Extract<Val, { k: "ref" }> => v.k === "ref",
    );
    if (refs.length === 0) {
      // A library hook walked on its own: its references arrive as arguments
      // and resolve only in the walks that start from an app.
      if (unit.app !== undefined) {
        this.addUnresolved(
          unit,
          "clientCall",
          call,
          "The function reference is not one the analysis can trace",
        );
      }
      return;
    }
    let all = true;
    for (const ref of refs) {
      const target = this.resolvers.functionFromRef(ref, unit.owner);
      if (target === null) {
        all = false;
        continue;
      }
      this.emit(unit, "clientCalls", target, [this.location(call)], {
        app: unit.app,
      });
    }
    if (all) {
      this.resolved(call);
    } else {
      this.addUnresolved(
        unit,
        "clientCall",
        call,
        "The reference names no function of the app",
      );
    }
  }

  private recordTableAccess(
    call: ts.CallExpression,
    op: string,
    env: Env,
    unit: Unit,
  ): void {
    const access = DB_WRITES.has(op) ? "writes" : "reads";
    const first = call.arguments[0];
    let tables: string[] = [];
    if (first !== undefined) {
      const values = this.evaluate(first, env);
      if (values.length > 0 && values.every((v) => v.k === "str")) {
        tables = values.map((v) => (v as { value: string }).value);
      } else {
        // The single-argument form takes an id; its type names the table.
        const type = this.checker.getTypeAtLocation(first);
        const match = /^(?:Generic)?Id<"([^"]+)">$/.exec(
          this.checker.typeToString(type),
        );
        if (match !== null) {
          tables = [match[1]!];
        }
      }
    }
    if (tables.length === 0) {
      this.addUnresolved(
        unit,
        "table",
        call,
        `The table of \`ctx.db.${op}\` is not a literal or a typed id`,
      );
      return;
    }
    if (unit.owner === null) {
      this.addUnresolved(
        unit,
        "table",
        call,
        `\`ctx.db.${op}("${tables.join('" | "')}")\` reads a table of the app, which each app defines`,
      );
      return;
    }
    for (const table of tables) {
      const id = this.resolvers.table(unit.owner, table);
      if (id === null) {
        this.addUnresolved(
          unit,
          "table",
          call,
          `No table "${table}" in the schema of the owner`,
        );
        continue;
      }
      this.resolved(call);
      this.emit(unit, access, id, [this.location(call)], {
        via: op,
        app: unit.app,
      });
    }
  }

  private recordFetch(call: ts.CallExpression, env: Env, unit: Unit): void {
    const values = this.evaluate(call.arguments[0], env);
    if (values.length === 0 || values.some((v) => v.k !== "str")) {
      this.addUnresolved(
        unit,
        "fetch",
        call,
        "The URL is not a value the analysis can trace to a literal",
      );
      return;
    }
    let all = true;
    for (const value of values) {
      let host: string;
      try {
        host = new URL((value as { value: string }).value).host;
      } catch {
        all = false;
        continue;
      }
      const target = this.resolvers.thirdParty(host);
      if (target === null) {
        all = false;
        continue;
      }
      this.emit(unit, "fetches", target, [this.location(call)], {
        via: host,
        app: unit.app,
      });
    }
    if (all) {
      this.resolved(call);
    } else {
      this.addUnresolved(
        unit,
        "fetch",
        call,
        "The URL's host belongs to no known third party",
      );
    }
  }

  private recordChildComponentCall(
    call: ts.CallExpression,
    env: Env,
    unit: Unit,
  ): void {
    const callee = call.expression;
    const candidates: { expr: ts.Node; env: Env }[] = call.arguments.map(
      (expr) => ({ expr, env }),
    );
    if (ts.isPropertyAccessExpression(callee)) {
      for (const value of this.evaluate(callee.expression, env)) {
        if (value.k === "node" && ts.isNewExpression(value.node)) {
          for (const arg of value.node.arguments ?? []) {
            candidates.push({ expr: arg, env: value.env });
          }
        }
      }
    }
    const via = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    // Only the child's own client library calls into it: the callee must be
    // declared by the npm package of the child component.
    const calleeFiles = (
      this.symbolAt(
        ts.isPropertyAccessExpression(callee) ? callee.name : callee,
      )?.declarations ?? []
    ).map((d) => d.getSourceFile().fileName);
    if (calleeFiles.length === 0) {
      return;
    }
    for (const candidate of candidates) {
      for (const value of this.evaluate(candidate.expr, candidate.env)) {
        if (
          value.k === "ref" &&
          value.root === "components" &&
          value.path.length === 1
        ) {
          const target = this.resolvers.componentFromRef(
            value.ownerDir,
            value.path[0]!,
            unit.owner,
          );
          const pkg =
            target === null ? null : this.resolvers.componentPackage(target);
          if (
            target !== null &&
            pkg !== null &&
            calleeFiles.every((f) => f.includes(`/node_modules/${pkg}/`))
          ) {
            this.emit(
              unit,
              "callsChildComponent",
              target,
              [this.location(call)],
              {
                via,
                app: unit.app,
              },
            );
          }
        }
      }
    }
  }

  private recordRoute(call: ts.CallExpression, env: Env, unit: Unit): void {
    const spec = this.evaluate(call.arguments[0], env).find(
      (v) => v.k === "node",
    );
    if (spec === undefined) {
      this.addUnresolved(
        unit,
        "httpRoute",
        call,
        "The route's options are not an object literal the analysis can read",
      );
      return;
    }
    const path = this.property(spec, "path");
    const method = this.property(spec, "method");
    let handler: { node: FunctionLike; env: Env } | null = null;
    for (const { expr, env: e } of this.propertyExpressions(
      spec,
      "handler",
    ).flatMap((p) => this.trace(p.expr, p.env))) {
      // httpAction(fn) / httpActionGeneric(fn)
      if (
        expr !== undefined &&
        ts.isCallExpression(expr) &&
        expr.arguments.length === 1
      ) {
        const fn = this.evaluate(expr.arguments[0], e).find(
          (v): v is Extract<Val, { k: "node" }> =>
            v.k === "node" && isFunctionLike(v.node),
        );
        if (fn !== undefined) {
          handler = { node: fn.node as FunctionLike, env: fn.env };
        }
      }
    }
    this.resolvers.onRoute({ unit, call, path, method, handler });
  }
}

export function propertyNameText(
  name: ts.PropertyName | ts.Node,
): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) {
    return null;
  }
  return null;
}

/** The expressions a function returns, outside of its nested functions. */
export function returnExpressions(fn: FunctionLike): ts.Expression[] {
  if (fn.body === undefined) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node) || ts.isClassDeclaration(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      out.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}
