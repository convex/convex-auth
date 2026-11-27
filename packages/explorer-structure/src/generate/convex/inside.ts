/**
 * The inside of a TypeScript module, read from its source: the first sentence
 * and the first paragraph of its module doc comment, its exports with their
 * own doc comments, and the places where it keeps state. Plain TypeScript: it
 * knows neither Convex nor a project.
 *
 * Doc text is copied from the source. The reader joins the lines of a
 * paragraph with single spaces and writes `{@link X}` as `X` (or as its text,
 * `{@link X | text}`); it changes nothing else.
 *
 * @module
 */
import ts from "typescript";
import type {
  ExportKind,
  ModuleExport,
  ModuleInside,
  ModuleState,
} from "../../model.ts";

export type InsideOptions = {
  checker: ts.TypeChecker;
  /** A path from the repository root. */
  path: (absolute: string) => string;
  /** The part id of a module the model has, by its file name. */
  moduleOfFile?: (fileName: string) => string | null;
  /** The part that a declaration is, if the model has one (a hook). */
  partOf?: (declaration: ts.Node) => string | null;
};

export function readModuleInside(
  file: ts.SourceFile,
  options: InsideOptions,
): ModuleInside {
  const doc = moduleDocComment(file);
  const text = doc === null ? null : docText(doc);
  const paragraph = text === null ? null : firstParagraph(text);
  return {
    file: options.path(file.fileName),
    ...(paragraph === null
      ? {}
      : { summary: firstSentence(paragraph), description: paragraph }),
    exports: readExports(file, options),
    state: readState(file),
  };
}

// ------------------------------------------------------------------- docs

/**
 * The raw text of the module doc comment: the first `/** … *\/` before the
 * first statement, when it carries `@module`, when another doc comment
 * follows it, or when the statement it precedes is not a declaration it could
 * document (an import, a directive). Else it documents that declaration.
 */
export function moduleDocComment(file: ts.SourceFile): string | null {
  const text = file.getFullText();
  const first = file.statements[0];
  const end = first === undefined ? text.length : first.getStart(file);
  const comments = (ts.getLeadingCommentRanges(text, 0) ?? []).filter(
    (c) =>
      c.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      c.end <= end &&
      text.startsWith("/**", c.pos) &&
      !text.startsWith("/**/", c.pos),
  );
  const comment = comments[0];
  if (comment === undefined) {
    return null;
  }
  const raw = text.slice(comment.pos, comment.end);
  if (
    /@module\b/.test(raw) ||
    comments.length > 1 ||
    first === undefined ||
    ts.isImportDeclaration(first) ||
    ts.isImportEqualsDeclaration(first) ||
    (ts.isExportDeclaration(first) && first.moduleSpecifier !== undefined) ||
    (ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression))
  ) {
    return raw;
  }
  return null;
}

/** The text of a doc comment, without its delimiters, its `*`s, and its tags. */
export function docText(raw: string): string {
  const lines = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\* ?)?/, "").trimEnd());
  const tag = lines.findIndex((line) => /^@\w/.test(line));
  return (tag === -1 ? lines : lines.slice(0, tag))
    .join("\n")
    .replace(
      /\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+?)|\s+([^}]+?))?\s*\}/g,
      (_, target: string, piped?: string, spaced?: string) =>
        (piped ?? spaced ?? target).trim(),
    )
    .trim();
}

/** The first paragraph, its lines joined with single spaces. */
export function firstParagraph(text: string): string | null {
  const paragraph = text.split(/\n\s*\n/)[0]!.trim();
  return paragraph === "" ? null : paragraph.split(/\s*\n\s*/).join(" ");
}

const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf)$/;

/**
 * The first sentence: up to the first `.`, `!`, or `?` that a space or the
 * end follows, outside backticks and not ending an abbreviation such as
 * `e.g.`. The whole paragraph when no sentence ends in it.
 */
export function firstSentence(paragraph: string): string {
  let inCode = false;
  for (let i = 0; i < paragraph.length; i++) {
    const c = paragraph[i]!;
    if (c === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || !".!?".includes(c)) {
      continue;
    }
    const next = paragraph[i + 1];
    if (next !== undefined && !/\s/.test(next)) {
      continue;
    }
    if (c === "." && ABBREVIATIONS.test(paragraph.slice(0, i))) {
      continue;
    }
    return paragraph.slice(0, i + 1);
  }
  return paragraph;
}

/** The first sentence of the doc comment of a declaration, if it has one. */
export function declarationSummary(node: ts.Node): string | undefined {
  const holder =
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : node;
  const docs = ts
    .getJSDocCommentsAndTags(holder)
    .filter((d): d is ts.JSDoc => ts.isJSDoc(d));
  const doc = docs.at(-1);
  if (doc === undefined) {
    return undefined;
  }
  const paragraph = firstParagraph(docText(doc.getText()));
  return paragraph === null ? undefined : firstSentence(paragraph);
}

// ---------------------------------------------------------------- exports

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

const isFunctionValue = (node: ts.Node | undefined) =>
  node !== undefined &&
  (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

function declarationKind(declaration: ts.Node): ExportKind | null {
  if (ts.isFunctionDeclaration(declaration)) return "function";
  if (ts.isClassDeclaration(declaration)) return "class";
  if (ts.isInterfaceDeclaration(declaration)) return "interface";
  if (ts.isTypeAliasDeclaration(declaration)) return "type";
  if (ts.isEnumDeclaration(declaration)) return "enum";
  if (ts.isModuleDeclaration(declaration) || ts.isSourceFile(declaration))
    return "namespace";
  if (ts.isVariableDeclaration(declaration)) {
    if (isFunctionValue(declaration.initializer)) return "function";
    return ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
      ? "const"
      : "let";
  }
  return null;
}

function readExports(
  file: ts.SourceFile,
  options: InsideOptions,
): ModuleExport[] {
  const { checker } = options;
  const out: ModuleExport[] = [];
  const seen = new Set<string>();
  const line = (node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const push = (entry: ModuleExport) => {
    if (seen.has(entry.name)) {
      return; // an overload, or a declaration merged with another
    }
    seen.add(entry.name);
    out.push(entry);
  };
  const local = (
    name: string,
    declaration: ts.Node,
    kind: ExportKind,
    at: ts.Node,
  ) => {
    const part =
      options.partOf?.(declaration) ??
      (ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
        ? options.partOf?.(declaration.initializer)
        : null) ??
      null;
    const summary = declarationSummary(declaration);
    push({
      name,
      kind,
      line: line(at),
      ...(summary === undefined ? {} : { summary }),
      ...(part === null ? {} : { part }),
      ...(ts.isClassDeclaration(declaration)
        ? { members: classMembers(declaration, file) }
        : {}),
    });
  };
  /** Where a module specifier leads: a module part, a repository file, or the specifier. */
  const origin = (specifier: ts.Expression): string => {
    const text = ts.isStringLiteral(specifier) ? specifier.text : "";
    const target = checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    if (target === undefined || !ts.isSourceFile(target)) {
      return text;
    }
    const part = options.moduleOfFile?.(target.fileName) ?? null;
    if (part !== null) {
      return part;
    }
    const path = options.path(target.fileName);
    return path.includes("node_modules/") || path.startsWith("..")
      ? text
      : path;
  };
  const reexport = (
    name: string,
    original: ts.Symbol | undefined,
    from: string,
    at: ts.Node,
  ) => {
    const declaration =
      original?.valueDeclaration ?? original?.declarations?.[0];
    const summary =
      declaration === undefined ? undefined : declarationSummary(declaration);
    const part =
      declaration === undefined
        ? null
        : (options.partOf?.(declaration) ?? null);
    push({
      name,
      kind:
        (declaration === undefined ? null : declarationKind(declaration)) ??
        "const",
      line: line(at),
      ...(summary === undefined ? {} : { summary }),
      from,
      ...(part === null ? {} : { part }),
    });
  };

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        out.push({
          name: "*",
          kind: "all",
          line: line(statement),
          from: origin(statement.moduleSpecifier!),
        });
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        push({
          name: clause.name.text,
          kind: "namespace",
          line: line(statement),
          from: origin(statement.moduleSpecifier!),
        });
        continue;
      }
      for (const element of clause.elements) {
        const symbol = checker.getSymbolAtLocation(element.name);
        const original =
          symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        if (statement.moduleSpecifier !== undefined) {
          reexport(
            element.name.text,
            original,
            origin(statement.moduleSpecifier),
            element,
          );
          continue;
        }
        // `export { a }`: a local declaration, or an import passed on.
        const localSymbol =
          checker.getExportSpecifierLocalTargetSymbol(element);
        const importDeclaration = localSymbol?.declarations?.find(
          (d) =>
            ts.isImportSpecifier(d) ||
            ts.isImportClause(d) ||
            ts.isNamespaceImport(d),
        );
        if (importDeclaration !== undefined) {
          let node: ts.Node = importDeclaration;
          while (!ts.isImportDeclaration(node)) node = node.parent;
          reexport(
            element.name.text,
            original,
            origin(node.moduleSpecifier),
            element,
          );
          continue;
        }
        const declaration =
          original?.valueDeclaration ?? original?.declarations?.[0];
        if (declaration !== undefined) {
          local(
            element.name.text,
            declaration,
            declarationKind(declaration) ?? "const",
            element,
          );
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      push({ name: "default", kind: "default", line: line(statement) });
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          local(
            declaration.name.text,
            declaration,
            declarationKind(declaration)!,
            declaration,
          );
        }
      }
      continue;
    }
    const kind = declarationKind(statement);
    const name = (statement as ts.DeclarationStatement).name;
    if (kind === null) {
      continue;
    }
    local(
      isDefault
        ? "default"
        : name !== undefined && ts.isIdentifier(name)
          ? name.text
          : "default",
      statement,
      kind,
      statement,
    );
  }
  return out;
}

// ------------------------------------------------------------------ state

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** A field that holds a function (a method written as an arrow) is code, not state. */
const isFunctionField = (member: ts.PropertyDeclaration) =>
  isFunctionValue(member.initializer) ||
  (member.type !== undefined && ts.isFunctionTypeNode(member.type));

const memberName = (name: ts.PropertyName, file: ts.SourceFile) =>
  ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : name.getText(file);

/**
 * The public members of a class: its methods (and fields that hold a
 * function) and its other fields, in the order of the source. Private
 * members (`#name`, `private`) are left out.
 */
function classMembers(
  node: ts.ClassLikeDeclaration,
  file: ts.SourceFile,
): NonNullable<ModuleExport["members"]> {
  const out: NonNullable<ModuleExport["members"]> = [];
  const seen = new Set<string>();
  for (const member of node.members) {
    if (
      member.name === undefined ||
      ts.isPrivateIdentifier(member.name) ||
      hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
    ) {
      continue;
    }
    const kind = ts.isMethodDeclaration(member)
      ? "method"
      : ts.isPropertyDeclaration(member)
        ? isFunctionField(member)
          ? "method"
          : "field"
        : ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ? "accessor"
          : null;
    const name = memberName(member.name, file);
    if (kind === null || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const summary = declarationSummary(member);
    out.push({
      name,
      kind,
      line: file.getLineAndCharacterOfPosition(member.getStart(file)).line + 1,
      ...(hasModifier(member, ts.SyntaxKind.StaticKeyword)
        ? { static: true }
        : {}),
      ...(summary === undefined ? {} : { summary }),
    });
  }
  return out;
}

function readState(file: ts.SourceFile): ModuleState[] {
  const out: ModuleState[] = [];
  const line = (node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const withSummary = (entry: ModuleState, node: ts.Node): ModuleState => {
    const summary = declarationSummary(node);
    return summary === undefined ? entry : { ...entry, summary };
  };
  const readClass = (node: ts.ClassLikeDeclaration) => {
    const className = node.name?.text ?? "default";
    for (const member of node.members) {
      const parameters = ts.isConstructorDeclaration(member)
        ? member.parameters
        : [];
      for (const parameter of parameters) {
        if (
          ts.isParameterPropertyDeclaration(parameter, member) &&
          ts.isIdentifier(parameter.name)
        ) {
          out.push(field(parameter.name.text, parameter, className));
        }
      }
      if (!ts.isPropertyDeclaration(member) || isFunctionField(member)) {
        continue;
      }
      out.push(field(memberName(member.name, file), member, className));
    }
  };
  const field = (
    name: string,
    node: ts.PropertyDeclaration | ts.ParameterDeclaration,
    className: string,
  ): ModuleState => {
    const isPrivate =
      name.startsWith("#") || hasModifier(node, ts.SyntaxKind.PrivateKeyword);
    return withSummary(
      {
        name,
        kind: "field",
        line: line(node),
        class: className,
        ...(hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)
          ? { readonly: true }
          : {}),
        ...(isPrivate ? { private: true } : {}),
        ...(hasModifier(node, ts.SyntaxKind.StaticKeyword)
          ? { static: true }
          : {}),
      },
      node,
    );
  };

  for (const statement of file.statements) {
    if (ts.isClassDeclaration(statement)) {
      readClass(statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const flags = statement.declarationList.flags;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      const name = declaration.name.text;
      if (flags & ts.NodeFlags.Let || !(flags & ts.NodeFlags.BlockScoped)) {
        out.push(
          withSummary(
            {
              name,
              kind: flags & ts.NodeFlags.Let ? "let" : "var",
              line: line(declaration),
            },
            declaration,
          ),
        );
        continue;
      }
      const init = declaration.initializer;
      const declared = declaration.type?.getText(file) ?? "";
      if (
        init !== undefined &&
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        COLLECTIONS.has(init.expression.text) &&
        !/^Readonly/.test(declared)
      ) {
        out.push(
          withSummary(
            { name, kind: "collection", line: line(declaration) },
            declaration,
          ),
        );
      } else if (init !== undefined && ts.isClassExpression(init)) {
        readClass(init);
      }
    }
  }
  return out;
}
