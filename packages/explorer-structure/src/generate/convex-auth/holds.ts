/**
 * What the client modules of Convex Auth hold, where the source says it
 * plainly: the stored keys they read and write through the storage views of
 * `browser/storage.ts`, and the locks they take with `runWithMutex`.
 *
 * A key counts only when the source spells it out: a string literal, a
 * constant of a literal type, or a property of a constant object literal (an
 * index with a variable counts as a use of each key that object holds). Any
 * other key goes to `unresolvedStorage`. The calls inside `browser/storage.ts`
 * are left out: there the views forward the keys their callers give.
 *
 * @module
 */
import ts from "typescript";
import type {
  LockUse,
  ModuleHolds,
  StorageKeyUse,
} from "../../convex-auth/model.ts";
import { findCalls } from "../convex/project.ts";
import {
  calleeDeclaration,
  exportedDeclaration,
  stringValue,
  type SourceScanOptions,
} from "./steps.ts";

export type HoldsOptions = SourceScanOptions & {
  program: ts.Program;
  /** `browser/storage.ts` and `browser/mutex.ts`, absolute. */
  storageFile: string;
  mutexFile: string;
  /** The module part of a file. */
  moduleOfFile: (fileName: string) => string | null;
};

const STORES = ["NamespacedStorage", "SignInStorage"] as const;
const OPS = ["get", "set", "remove", "key"] as const;

/** The storage view a method belongs to, when it is one of `browser/storage.ts`. */
function storeOf(
  checker: ts.TypeChecker,
  callee: ts.PropertyAccessExpression,
  storageFile: string,
): StorageKeyUse["store"] | null {
  const declaration = checker.getSymbolAtLocation(callee.name)
    ?.declarations?.[0];
  if (
    declaration === undefined ||
    declaration.getSourceFile().fileName !== storageFile
  ) {
    return null;
  }
  for (let n: ts.Node = declaration.parent; ; n = n.parent) {
    if (ts.isSourceFile(n)) return null;
    if (
      (ts.isClassDeclaration(n) || ts.isTypeAliasDeclaration(n)) &&
      n.name !== undefined
    ) {
      const name = n.name.text;
      return (STORES as readonly string[]).includes(name)
        ? (name as StorageKeyUse["store"])
        : null;
    }
  }
}

/** The keys a key argument spells out, or `null`. */
function keysOf(checker: ts.TypeChecker, expr: ts.Expression): string[] | null {
  const value = stringValue(checker, expr);
  if (value !== null) {
    return [value];
  }
  const objectOf = (e: ts.Expression) => {
    const declaration = ts.isIdentifier(e)
      ? checker.getSymbolAtLocation(e)?.valueDeclaration
      : undefined;
    return declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const &&
      declaration.initializer !== undefined &&
      ts.isObjectLiteralExpression(declaration.initializer)
      ? declaration.initializer
      : null;
  };
  const valueOf = (property: ts.ObjectLiteralElementLike) =>
    ts.isPropertyAssignment(property)
      ? stringValue(checker, property.initializer)
      : null;
  if (ts.isPropertyAccessExpression(expr)) {
    const object = objectOf(expr.expression);
    const property = object?.properties.find(
      (p) =>
        p.name !== undefined &&
        ts.isIdentifier(p.name) &&
        p.name.text === expr.name.text,
    );
    const found = property === undefined ? null : valueOf(property);
    return found === null ? null : [found];
  }
  if (ts.isElementAccessExpression(expr)) {
    const object = objectOf(expr.expression);
    if (object === null) return null;
    const values = object.properties.map(valueOf);
    return values.every((v) => v !== null) ? (values as string[]) : null;
  }
  return null;
}

/** The lock name of a `runWithMutex` call: a stored key of a `NamespacedStorage`, by its logical key. */
function lockKey(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  storageFile: string,
): string | null {
  const viaKey = (e: ts.Expression | undefined): string | null => {
    if (
      e === undefined ||
      !ts.isCallExpression(e) ||
      !ts.isPropertyAccessExpression(e.expression) ||
      e.expression.name.text !== "key" ||
      storeOf(checker, e.expression, storageFile) !== "NamespacedStorage" ||
      e.arguments[0] === undefined
    ) {
      return null;
    }
    return stringValue(checker, e.arguments[0]);
  };
  const direct = viaKey(expr);
  if (direct !== null || !ts.isPropertyAccessExpression(expr)) {
    return direct;
  }
  // `this.#field`: the field's one assignment in its class.
  const declaration = checker.getSymbolAtLocation(expr.name)?.valueDeclaration;
  if (declaration === undefined || !ts.isPropertyDeclaration(declaration)) {
    return null;
  }
  const assigned: ts.Expression[] = [];
  if (declaration.initializer !== undefined) {
    assigned.push(declaration.initializer);
  }
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      checker.getSymbolAtLocation(n.left.name)?.valueDeclaration === declaration
    ) {
      assigned.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(declaration.parent);
  return assigned.length === 1 ? viaKey(assigned[0]) : null;
}

/** What each module holds, by its part id; only modules that hold something. */
export function scanHolds(options: HoldsOptions): Record<string, ModuleHolds> {
  const { checker, program } = options;
  const mutex = exportedDeclaration(
    program,
    checker,
    options.mutexFile,
    "runWithMutex",
  );
  const out: Record<string, ModuleHolds> = {};
  for (const file of options.files) {
    const part = options.moduleOfFile(file.fileName);
    if (part === null || file.fileName === options.storageFile) {
      continue;
    }
    const uses = new Map<string, StorageKeyUse>();
    const holds: ModuleHolds = {
      storage: [],
      unresolvedStorage: [],
      locks: [],
    };
    for (const call of findCalls(file, () => true)) {
      const callee = call.expression;
      if (calleeDeclaration(checker, call) === mutex) {
        const argument = call.arguments[0];
        if (argument !== undefined) {
          const lock: LockUse = {
            storageKey: lockKey(checker, argument, options.storageFile),
            code: argument.getText(),
            location: options.location(call),
          };
          holds.locks.push(lock);
        }
        continue;
      }
      if (
        !ts.isPropertyAccessExpression(callee) ||
        !(OPS as readonly string[]).includes(callee.name.text)
      ) {
        continue;
      }
      const store = storeOf(checker, callee, options.storageFile);
      const argument = call.arguments[0];
      if (store === null || argument === undefined) {
        continue;
      }
      const keys = keysOf(checker, argument);
      if (keys === null) {
        holds.unresolvedStorage.push({
          code: call.getText().split("\n")[0]!.slice(0, 120),
          location: options.location(call),
        });
        continue;
      }
      const op = callee.name.text as StorageKeyUse["ops"][number];
      for (const key of keys) {
        const id = `${store} ${key}`;
        const use = uses.get(id) ?? { key, store, ops: [], evidence: [] };
        if (!use.ops.includes(op)) use.ops.push(op);
        use.evidence.push(options.location(call));
        uses.set(id, use);
      }
    }
    holds.storage = [...uses.values()]
      .map((u) => ({ ...u, ops: [...u.ops].sort() }))
      .sort(
        (a, b) => a.key.localeCompare(b.key) || a.store.localeCompare(b.store),
      );
    if (
      holds.storage.length +
        holds.unresolvedStorage.length +
        holds.locks.length >
      0
    ) {
      out[part] = holds;
    }
  }
  return out;
}
