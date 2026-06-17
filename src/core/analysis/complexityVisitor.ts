import ts from "typescript";
import {
  FileReport,
  MethodKind,
  MethodMetric,
  TypeKind,
  TypeMetric,
  makeMethodMetric,
  methodId,
} from "../models.js";

/**
 * The traversal surface the grammar-dispatch free functions need. Implemented
 * by {@link ComplexityVisitor}. The dispatch logic (one function per grammar
 * category) lives outside the class so no single unit — neither a method nor
 * the class as a whole — carries the entire grammar's branching.
 */
export interface VisitContext {
  readonly sourceFile: ts.SourceFile;
  visitChildren(node: ts.Node): void;
  withType(kind: TypeKind, name: string, node: ts.Node, body: ts.Node): void;
  withMethod(name: string, kind: MethodKind, node: ts.Node): void;
  withNesting(node: ts.Node): void;
  bumpCyclomatic(): void;
  bumpCognitive(amount: number): void;
  currentNesting(): number;
}

/**
 * Walks a parsed TypeScript/JavaScript file and produces:
 *   - one `MethodMetric` per function-like declaration (functions, methods,
 *     constructors, accessors, and named arrow/function expressions)
 *   - one `TypeMetric` per enclosing container (class, interface, enum,
 *     namespace, method-bearing object literal), with summed and max
 *     complexity for the methods declared inside it
 *
 * The visitor computes **two** complexity metrics on a single walk:
 *
 * **Cyclomatic complexity (McCabe).** Each method starts at 1. Increments +1
 * for: `if`, `for`/`for-in`/`for-of`, `while`, `do`, each non-default `case`,
 * each `catch`, ternary `? :`, `&&`, `||`, `??` (and their compound-assignment
 * forms). `default:` and optional chaining (`?.`) are not counted. Preserved
 * for cross-tool comparability.
 *
 * **Cognitive complexity (SonarSource 2023 spec).** Each method starts at 0.
 * Three increment kinds:
 *   - **B. Structural** (+1 + nesting depth, bumps nesting for inner code):
 *     `if` (head of chain), ternary, `for` family, `while`, `do`, `switch`
 *     (the whole switch — *one* increment regardless of case count), `catch`.
 *   - **D. Hybrid** (+1 flat OR +0, bumps nesting for inner code): `else` and
 *     chained `else if` (each +1, no nesting penalty); anonymous arrow
 *     functions / function expressions used inline as callbacks (+0, nesting
 *     only).
 *   - **C. Fundamental** (+1 flat, no nesting interaction): each new run of
 *     like binary boolean operators (`a && b && c` is one run; `a && b || c
 *     && d` is three); labeled jumps (`break label` / `continue label`);
 *     `&&=` / `||=` compound boolean assignments.
 *
 * Ignored (cognitive +0): the method itself, `try`/`finally`, `??` / `??=`
 * and `?.`, `default:`, individual `case` labels (only the parent switch
 * counts), plain `return`/`break`/`continue` (early exits per the spec's "no
 * other jumps or early exits cause an increment" rule).
 *
 * Named arrow functions and function expressions — `const f = () => {}`,
 * `{ f: function () {} }`, class fields — get their own method frame (their
 * complexity does not leak into the enclosing scope). Anonymous inline
 * callbacks do not: their branches count toward the enclosing method, with a
 * nesting bump for the callback body.
 */
export class ComplexityVisitor implements VisitContext {
  private readonly filePath: string;
  readonly sourceFile: ts.SourceFile;

  private readonly methodStack: MethodFrame[] = [];
  private readonly typeStack: TypeFrame[] = [];

  readonly methods: MethodMetric[] = [];
  readonly types: TypeMetric[] = [];

  constructor(filePath: string, sourceFile: ts.SourceFile) {
    this.filePath = filePath;
    this.sourceFile = sourceFile;
  }

  walk(): void {
    this.visitChildren(this.sourceFile);
  }

  // MARK: - Dispatch

  private visit(node: ts.Node): void {
    // Each group returns true once it has consumed the node (recursing into
    // children itself where needed); otherwise we fall through to the next
    // group and finally to a plain child walk. The groups live as free
    // functions below so the grammar's branching doesn't pile onto this class.
    if (dispatchContainer(this, node)) return;
    if (dispatchDeclaration(this, node)) return;
    if (dispatchBranch(this, node)) return;
    this.visitChildren(node);
  }

  visitChildren(node: ts.Node): void {
    ts.forEachChild(node, (child) => this.visit(child));
  }

  // MARK: - Stack ops

  withType(kind: TypeKind, name: string, node: ts.Node, body: ts.Node): void {
    const { startLine, endLine } = this.lineRange(node);
    this.typeStack.push({
      kind,
      name,
      startLine,
      endLine,
      methodIDs: [],
      methodComplexities: [],
      methodCognitiveComplexities: [],
    });
    this.visitChildren(body);
    const frame = this.typeStack.pop()!;
    const metric: TypeMetric = {
      kind: frame.kind,
      name: frame.name,
      file: this.filePath,
      startLine: frame.startLine,
      endLine: frame.endLine,
      methodIDs: frame.methodIDs,
      methodCount: frame.methodIDs.length,
      totalComplexity: sum(frame.methodComplexities),
      maxComplexity: maxOrZero(frame.methodComplexities),
      totalCognitiveComplexity: sum(frame.methodCognitiveComplexities),
      maxCognitiveComplexity: maxOrZero(frame.methodCognitiveComplexities),
    };
    this.types.push(metric);
  }

  withMethod(name: string, kind: MethodKind, node: ts.Node): void {
    const { startLine, endLine } = this.lineRange(node);
    const typeChain = this.typeStack.map((t) => t.name);
    const typeName = typeChain.length > 0 ? typeChain[typeChain.length - 1]! : null;
    const qualifiedName = typeChain.length > 0 ? `${typeChain.join(".")}.${name}` : name;
    this.methodStack.push({
      name,
      qualifiedName,
      typeName,
      kind,
      startLine,
      endLine,
      complexity: 1, // cyclomatic base = 1
      cognitive: 0, // cognitive base = 0
      cognitiveNesting: 0,
    });
    this.visitChildren(node);
    const frame = this.methodStack.pop()!;
    const metric = makeMethodMetric({
      name: frame.name,
      qualifiedName: frame.qualifiedName,
      typeName: frame.typeName,
      kind: frame.kind,
      file: this.filePath,
      startLine: frame.startLine,
      endLine: frame.endLine,
      complexity: frame.complexity,
      cognitiveComplexity: frame.cognitive,
    });
    this.methods.push(metric);
    const enclosingType = this.typeStack[this.typeStack.length - 1];
    if (enclosingType) {
      enclosingType.methodIDs.push(methodId(metric));
      enclosingType.methodComplexities.push(frame.complexity);
      enclosingType.methodCognitiveComplexities.push(frame.cognitive);
    }
  }

  withNesting(node: ts.Node): void {
    this.pushNesting();
    this.visitChildren(node);
    this.popNesting();
  }

  bumpCyclomatic(): void {
    const frame = this.methodStack[this.methodStack.length - 1];
    if (frame) frame.complexity += 1;
  }

  bumpCognitive(amount: number): void {
    /* v8 ignore next -- defensive guard: every caller passes amount >= 1 (1 + nesting, or a flat +1) */
    if (amount <= 0) return;
    const frame = this.methodStack[this.methodStack.length - 1];
    if (frame) frame.cognitive += amount;
  }

  currentNesting(): number {
    return this.methodStack[this.methodStack.length - 1]?.cognitiveNesting ?? 0;
  }

  private pushNesting(): void {
    const frame = this.methodStack[this.methodStack.length - 1];
    if (frame) frame.cognitiveNesting += 1;
  }

  private popNesting(): void {
    const frame = this.methodStack[this.methodStack.length - 1];
    if (frame) frame.cognitiveNesting -= 1;
  }

  // MARK: - Helpers

  private lineRange(node: ts.Node): { startLine: number; endLine: number } {
    const start = this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile));
    const end = this.sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return { startLine: start.line + 1, endLine: end.line + 1 };
  }
}

// MARK: - Grammar dispatch
//
// One free function per grammar category. They share the visitor's mutable
// traversal state through the VisitContext seam. Keeping them out of the class
// means each category's branching is its own small unit rather than summing
// into one oversized dispatch method (and class).

/** Type-like containers (class/interface/enum/namespace/method-bearing object). */
function dispatchContainer(ctx: VisitContext, node: ts.Node): boolean {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    ctx.withType("class", node.name?.text ?? bindingName(node, ctx.sourceFile) ?? "<anonymous>", node, node);
    return true;
  }
  if (ts.isInterfaceDeclaration(node)) {
    ctx.withType("interface", node.name.text, node, node);
    return true;
  }
  if (ts.isEnumDeclaration(node)) {
    ctx.withType("enum", node.name.text, node, node);
    return true;
  }
  if (ts.isModuleDeclaration(node)) {
    ctx.withType("namespace", node.name.getText(ctx.sourceFile), node, node);
    return true;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const name = bindingName(node, ctx.sourceFile);
    if (name !== null && hasMethodLikeMember(node)) {
      ctx.withType("object", name, node, node);
    } else {
      ctx.visitChildren(node);
    }
    return true;
  }
  return false;
}

/** Method-like declarations (functions, methods, ctors, accessors, named lambdas). */
function dispatchDeclaration(ctx: VisitContext, node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) {
    ctx.withMethod(node.name?.text ?? "<anonymous>", "function", node);
    return true;
  }
  if (ts.isMethodDeclaration(node)) {
    ctx.withMethod(propertyName(node.name, ctx.sourceFile), "method", node);
    return true;
  }
  if (ts.isConstructorDeclaration(node)) {
    ctx.withMethod("constructor", "constructor", node);
    return true;
  }
  if (ts.isGetAccessorDeclaration(node)) {
    ctx.withMethod(`${propertyName(node.name, ctx.sourceFile)}.get`, "getter", node);
    return true;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    ctx.withMethod(`${propertyName(node.name, ctx.sourceFile)}.set`, "setter", node);
    return true;
  }
  if (ts.isClassStaticBlockDeclaration(node)) {
    ctx.withMethod("static", "function", node);
    return true;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const name = bindingName(node, ctx.sourceFile);
    if (name !== null) {
      ctx.withMethod(name, ts.isArrowFunction(node) ? "arrow" : "functionExpression", node);
    } else {
      // Anonymous inline callback — D-Hybrid: +0 score, nesting bump only.
      // The SonarSource spec calls this out explicitly: "no structural
      // increment for lambdas ... such methods do increment the nesting
      // level when nested inside other method-like structures."
      ctx.withNesting(node);
    }
    return true;
  }
  return false;
}

/** Branching constructs that drive the cyclomatic/cognitive increments. */
function dispatchBranch(ctx: VisitContext, node: ts.Node): boolean {
  if (ts.isIfStatement(node)) {
    handleIf(ctx, node);
    return true;
  }
  if (ts.isConditionalExpression(node)) {
    ctx.bumpCyclomatic();
    ctx.bumpCognitive(1 + ctx.currentNesting());
    ctx.withNesting(node);
    return true;
  }
  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    ctx.bumpCyclomatic();
    ctx.bumpCognitive(1 + ctx.currentNesting());
    ctx.withNesting(node);
    return true;
  }
  if (ts.isCatchClause(node)) {
    ctx.bumpCyclomatic();
    ctx.bumpCognitive(1 + ctx.currentNesting());
    ctx.withNesting(node);
    return true;
  }
  if (ts.isSwitchStatement(node)) {
    // Per the Sonar spec, a switch — regardless of case count — is *one*
    // structural increment. Cases inside it don't add to cognitive (the
    // whole point of cognitive vs cyclomatic on flat dispatch). Cyclomatic
    // still increments per non-`default` case for cross-tool parity.
    ctx.bumpCognitive(1 + ctx.currentNesting());
    ctx.withNesting(node);
    return true;
  }
  if (ts.isCaseClause(node)) {
    ctx.bumpCyclomatic();
    ctx.visitChildren(node);
    return true;
  }
  if (ts.isBinaryExpression(node)) {
    handleBinary(ctx, node);
    return true;
  }
  if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) {
    // Labeled jumps are C-Fundamental per the spec; plain break/continue
    // are early exits and stay free.
    ctx.bumpCognitive(1);
    return true;
  }
  return false;
}

/**
 * `if` chain handling: the head `if` is B-Structural (+1+nesting); each
 * chained `else if` is D-Hybrid (+1 flat). A trailing plain `else` is also
 * D-Hybrid (+1 flat). Cyclomatic counts every `if` (head and chained) as +1.
 */
function handleIf(ctx: VisitContext, node: ts.IfStatement): void {
  ctx.bumpCyclomatic();
  const isChainedElseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
  ctx.bumpCognitive(isChainedElseIf ? 1 : 1 + ctx.currentNesting());
  if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) {
    ctx.bumpCognitive(1); // plain else: Hybrid +1
  }
  ctx.withNesting(node);
}

/**
 * Cyclomatic: every `&&` / `||` / `??` (and compound-assignment form) is a
 * branch. Cognitive run-collapse per spec: a sequence of like operators is
 * one increment; each transition between operator types adds another. With
 * a left-associative parse tree that reduces to: bump unless the immediate
 * parent is a binary expression with the same operator. Parens / negations
 * deliberately break the run (the parenthesized group counts its own runs).
 * `??` is a null-coalescing shorthand (Ignored cognitively).
 */
function handleBinary(ctx: VisitContext, node: ts.BinaryExpression): void {
  const op = node.operatorToken.kind;
  const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
  const isOr = op === ts.SyntaxKind.BarBarToken;
  const isCoalesce = op === ts.SyntaxKind.QuestionQuestionToken;
  const isBoolAssign =
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken;
  const isCoalesceAssign = op === ts.SyntaxKind.QuestionQuestionEqualsToken;

  if (isAnd || isOr || isCoalesce || isBoolAssign || isCoalesceAssign) {
    ctx.bumpCyclomatic();
  }
  if (isAnd || isOr) {
    const parent = node.parent;
    const continuesRun = ts.isBinaryExpression(parent) && parent.operatorToken.kind === op;
    if (!continuesRun) ctx.bumpCognitive(1);
  }
  if (isBoolAssign) {
    ctx.bumpCognitive(1);
  }
  ctx.visitChildren(node);
}

interface MethodFrame {
  name: string;
  qualifiedName: string;
  typeName: string | null;
  kind: MethodKind;
  startLine: number;
  endLine: number;
  complexity: number;
  cognitive: number;
  cognitiveNesting: number;
}

interface TypeFrame {
  kind: TypeKind;
  name: string;
  startLine: number;
  endLine: number;
  methodIDs: string[];
  methodComplexities: number[];
  methodCognitiveComplexities: number[];
}

function propertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

/**
 * The name an expression is bound to, when it sits in a "named position":
 * a variable declaration initializer, an object property assignment, or a
 * class field initializer. `null` for anonymous inline positions.
 */
function bindingName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parent = node.parent;
  /* v8 ignore next -- defensive: bindingName only ever runs on declaration/expression nodes, which always have a parent */
  if (parent === undefined) return null;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return propertyName(parent.name, sourceFile);
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) {
    return propertyName(parent.name, sourceFile);
  }
  return null;
}

/**
 * Whether an object literal contains at least one method-like member. Plain
 * data/config object literals are everywhere in TS — only method-bearing ones
 * are interesting as type-level aggregation units.
 */
function hasMethodLikeMember(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((p) => {
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
      return true;
    }
    if (ts.isPropertyAssignment(p)) {
      return ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer);
    }
    return false;
  });
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function maxOrZero(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
