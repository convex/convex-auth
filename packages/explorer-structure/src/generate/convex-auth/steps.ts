/**
 * The places that report steps, read from the source. Convex Auth reports
 * steps through two functions, `reportClientStep` on the client and
 * `reportStep` on the server; each is a {@link StepReporter}, so a project
 * with its own reporter passes its own.
 *
 * For each call the scan reads the step's name, the part the report names
 * (or, when it is passed in, every value the callers pass), the names of the
 * detail's keys, and the code around the call: the part that holds it, the
 * export it is in, and the named functions around it. It reads names only,
 * never a value that the code computes.
 *
 * @module
 */
import ts from "typescript";
import type { SourceLocation } from "../../model.ts";
import type { StepSite } from "../../convex-auth/model.ts";
import { findCalls } from "../convex/project.ts";

/** A function that reports a step, and which of its arguments say what. */
export type StepReporter = {
  /** The file that declares it (absolute) and its exported name. */
  file: string;
  name: string;
  runsIn: StepSite["runsIn"];
  /** The positions of the arguments: the step's name, its detail, and the part it names (when it names one). */
  args: { step: number; detail: number; part?: number };
};

export type SourceScanOptions = {
  checker: ts.TypeChecker;
  /** The files to scan. */
  files: readonly ts.SourceFile[];
  location: (node: ts.Node) => SourceLocation;
};

export type StepScanOptions = SourceScanOptions & {
  program: ts.Program;
  /** The part whose code holds a node, if any. */
  partAt: (node: ts.Node) => string | null;
};

/** The declaration a call's callee resolves to, through imports. */
export function calleeDeclaration(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.Declaration | undefined {
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** The exported declaration `name` of `file`. */
export function exportedDeclaration(
  program: ts.Program,
  checker: ts.TypeChecker,
  file: string,
  name: string,
): ts.Declaration {
  const source = program.getSourceFile(file);
  const moduleSymbol =
    source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const symbol = moduleSymbol?.exports?.get(ts.escapeLeadingUnderscores(name));
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) {
    throw new Error(`${file} exports no ${name}`);
  }
  return declaration;
}

/** The value of a string the types spell out: a literal, or a constant of a literal type. */
export function stringValue(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): string | null {
  const type = checker.getTypeAtLocation(expr);
  return type.isStringLiteral() ? type.value : null;
}

/** The function-like node a declaration names: itself, or the function a variable holds. */
function functionOf(declaration: ts.Node): ts.Node | null {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return null;
}

/** The name a function-like node goes by, if it has one. */
function nameOf(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)) &&
    node.name !== undefined
  ) {
    return node.name.text;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)
      ? node.name.text
      : null;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  // A variable that holds a function, an object of functions, or the result
  // of a call it is passed to (`const signOut = mutationGeneric({ handler })`).
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer) ||
      ts.isCallExpression(node.initializer) ||
      ts.isObjectLiteralExpression(node.initializer))
  ) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
    ) {
      return parent.name.text;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node
    ) {
      const left = parent.left;
      if (ts.isPropertyAccessExpression(left)) return left.name.text;
      if (ts.isIdentifier(left)) return left.text;
    }
  }
  return null;
}

/** The named functions and classes around a node, outermost first. */
export function within(node: ts.Node): string[] {
  const names: string[] = [];
  for (let n = node.parent; !ts.isSourceFile(n); n = n.parent) {
    const name = nameOf(n);
    if (name !== null) {
      names.unshift(name);
    }
  }
  return names;
}

/** The statement at the top of the file that holds a node. */
function topLevel(node: ts.Node): ts.Statement {
  let n = node;
  while (!ts.isSourceFile(n.parent)) {
    n = n.parent;
  }
  return n as ts.Statement;
}

/**
 * Which top-level code of a file is exported: from each export of the file
 * to the declarations it names in that file.
 */
function exportsOfFile(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
): Map<ts.Node, string> {
  const out = new Map<ts.Node, string>();
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) {
    return out;
  }
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    for (const declaration of target.declarations ?? []) {
      if (declaration.getSourceFile() === file) {
        out.set(declaration, symbol.name);
      }
    }
  }
  return out;
}

/**
 * The export that holds a node, or else the exports that reach the
 * top-level code holding it, through references in the same file.
 */
export function exportAround(
  checker: ts.TypeChecker,
  node: ts.Node,
): { export: string | null; reachedFrom?: string[] } {
  const file = node.getSourceFile();
  const exported = exportsOfFile(checker, file);
  const exportOfStatement = (statement: ts.Statement): string | null => {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        const name = exported.get(d);
        if (name !== undefined) return name;
      }
      return null;
    }
    return exported.get(statement) ?? null;
  };
  const statement = topLevel(node);
  const direct = exportOfStatement(statement);
  if (direct !== null) {
    return { export: direct };
  }
  // Not exported: follow the references to its names within the file.
  const reached = new Set<string>();
  const seen = new Set<ts.Statement>([statement]);
  const queue = [statement];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const symbols = declaredSymbols(checker, current);
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        const symbol = checker.getSymbolAtLocation(n);
        if (symbol !== undefined && symbols.has(symbol)) {
          const holder = topLevel(n);
          if (!seen.has(holder)) {
            seen.add(holder);
            const name = exportOfStatement(holder);
            if (name !== null) {
              reached.add(name);
            } else {
              queue.push(holder);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(file);
  }
  return { export: null, reachedFrom: [...reached].sort() };
}

function declaredSymbols(
  checker: ts.TypeChecker,
  statement: ts.Statement,
): Set<ts.Symbol> {
  const names: ts.Node[] = [];
  if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) names.push(d.name);
  } else if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    names.push(statement.name);
  }
  return new Set(
    names
      .map((n) => checker.getSymbolAtLocation(n))
      .filter((s): s is ts.Symbol => s !== undefined),
  );
}

/** The names of the keys of an object a type describes, or `null` when the type does not tell them (an index signature). */
function keysOfType(checker: ts.TypeChecker, type: ts.Type): string[] | null {
  const members = type.isUnion() ? type.types : [type];
  const keys: string[] = [];
  for (const member of members) {
    if (checker.getIndexInfosOfType(member).length > 0) {
      return null;
    }
    for (const property of checker.getPropertiesOfType(member)) {
      keys.push(property.name);
    }
  }
  return keys;
}

/** The value of a string, number, or boolean literal written in the source, if `expr` is one. */
function literalValue(expr: ts.Expression): string | number | boolean | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/**
 * The names of a detail's keys, the code of the parts whose keys are not
 * known, and the values the source writes as literals (source text, never a
 * value the code computes).
 */
export function detailKeys(
  checker: ts.TypeChecker,
  expr: ts.Expression | undefined,
): {
  keys: string[];
  open: string[];
  literals: Record<string, string | number | boolean>;
} {
  const keys: string[] = [];
  const open: string[] = [];
  const literals: Record<string, string | number | boolean> = {};
  const fromType = (e: ts.Expression) => {
    const found = keysOfType(checker, checker.getTypeAtLocation(e));
    if (found === null) {
      open.push(e.getText());
    } else {
      keys.push(...found);
    }
  };
  if (expr === undefined) {
    return { keys, open, literals };
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isSpreadAssignment(property)) {
        fromType(property.expression);
      } else if (property.name !== undefined) {
        const name =
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
            ? property.name.text
            : property.name.getText();
        keys.push(name);
        const value = ts.isPropertyAssignment(property)
          ? literalValue(property.initializer)
          : null;
        if (value !== null) {
          literals[name] = value;
        }
      }
    }
  } else {
    fromType(expr);
  }
  return { keys: [...new Set(keys)], open, literals };
}

/** Every call in the files, by the function-like node its callee resolves to. */
export function callIndex(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
): Map<ts.Node, ts.CallExpression[]> {
  const index = new Map<ts.Node, ts.CallExpression[]>();
  for (const file of files) {
    for (const call of findCalls(file, () => true)) {
      const declaration = calleeDeclaration(checker, call);
      const fn = declaration === undefined ? null : functionOf(declaration);
      if (fn !== null) {
        const list = index.get(fn) ?? [];
        list.push(call);
        index.set(fn, list);
      }
    }
  }
  return index;
}

type Resolved =
  | { value: string }
  | {
      parameter: string;
      values: { part: string | null; location: SourceLocation }[];
    }
  | null;

/**
 * The string an argument holds: spelled out by the types, or a parameter of
 * the function around it, whose callers pass the values.
 */
function resolveArgument(
  options: SourceScanOptions,
  calls: Map<ts.Node, ts.CallExpression[]>,
  expr: ts.Expression,
  depth = 0,
): Resolved {
  const { checker } = options;
  const value = stringValue(checker, expr);
  if (value !== null) {
    return { value };
  }
  if (!ts.isIdentifier(expr) || depth > 4) {
    return null;
  }
  const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
  if (declaration === undefined || !ts.isParameter(declaration)) {
    return null;
  }
  const fn = declaration.parent;
  const position = fn.parameters.indexOf(declaration);
  const values: { part: string | null; location: SourceLocation }[] = [];
  for (const call of calls.get(fn) ?? []) {
    const argument = call.arguments[position];
    if (argument === undefined) {
      values.push({ part: null, location: options.location(call) });
      continue;
    }
    const resolved = resolveArgument(options, calls, argument, depth + 1);
    if (resolved === null) {
      values.push({ part: null, location: options.location(argument) });
    } else if ("value" in resolved) {
      values.push({
        part: resolved.value,
        location: options.location(argument),
      });
    } else {
      values.push(...resolved.values);
    }
  }
  return { parameter: expr.text, values };
}

/** The step sites of the reporters, in the order of file and line. */
export function scanStepSites(
  reporters: readonly StepReporter[],
  options: StepScanOptions,
): StepSite[] {
  const { checker, program } = options;
  const declarations = new Map(
    reporters.map((r) => [
      exportedDeclaration(program, checker, r.file, r.name),
      r,
    ]),
  );
  const calls = callIndex(checker, options.files);
  const sites: StepSite[] = [];
  for (const file of options.files) {
    for (const call of findCalls(file, () => true)) {
      const declaration = calleeDeclaration(checker, call);
      const reporter =
        declaration === undefined ? undefined : declarations.get(declaration);
      if (reporter === undefined) {
        continue;
      }
      const location = options.location(call);
      const stepArgument = call.arguments[reporter.args.step];
      const step =
        stepArgument === undefined ? null : stringValue(checker, stepArgument);
      if (step === null) {
        throw new Error(
          `${location.file}:${location.line}: the step's name is not spelled out in the source`,
        );
      }
      const { keys, open, literals } = detailKeys(
        checker,
        call.arguments[reporter.args.detail],
      );
      const partArgument =
        reporter.args.part === undefined
          ? undefined
          : call.arguments[reporter.args.part];
      const reportsAs =
        partArgument === undefined
          ? null
          : resolveArgument(options, calls, partArgument);
      sites.push({
        step,
        runsIn: reporter.runsIn,
        location,
        part: options.partAt(call),
        ...exportAround(checker, call),
        within: within(call),
        ...(reportsAs === null
          ? {}
          : "value" in reportsAs
            ? { reportsAs: reportsAs.value }
            : { reportsAsPassedIn: reportsAs }),
        detailKeys: keys,
        ...(open.length === 0 ? {} : { detailOpen: open }),
        ...(Object.keys(literals).length === 0
          ? {}
          : { detailLiterals: literals }),
      });
    }
  }
  return sites.sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );
}
