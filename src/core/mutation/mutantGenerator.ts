import ts from "typescript";
import { MutantSite } from "./models.js";
import { MutationOperator } from "./operators.js";

type Emit = (operator: MutationOperator, start: number, end: number, replacement: string) => void;

const K = ts.SyntaxKind;

const ARITHMETIC: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [K.PlusToken, "-"],
  [K.MinusToken, "+"],
  [K.AsteriskToken, "/"],
  [K.SlashToken, "*"],
  [K.PercentToken, "*"],
  [K.PlusEqualsToken, "-="],
  [K.MinusEqualsToken, "+="],
  [K.AsteriskEqualsToken, "/="],
  [K.SlashEqualsToken, "*="],
  [K.PercentEqualsToken, "*="],
]);

const BOUNDARY: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [K.LessThanToken, "<="],
  [K.LessThanEqualsToken, "<"],
  [K.GreaterThanToken, ">="],
  [K.GreaterThanEqualsToken, ">"],
]);

const NEGATE_CONDITIONAL: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [K.EqualsEqualsToken, "!="],
  [K.ExclamationEqualsToken, "=="],
  [K.EqualsEqualsEqualsToken, "!=="],
  [K.ExclamationEqualsEqualsToken, "==="],
  [K.LessThanToken, ">="],
  [K.LessThanEqualsToken, ">"],
  [K.GreaterThanToken, "<="],
  [K.GreaterThanEqualsToken, "<"],
]);

const LOGICAL: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [K.AmpersandAmpersandToken, "||"],
  [K.BarBarToken, "&&"],
]);

/** Parents whose statements sit in a braced block or a statement list. */
const STATEMENT_LISTS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.Block,
  K.SourceFile,
  K.ModuleBlock,
  K.CaseClause,
  K.DefaultClause,
]);

/**
 * Walks a parsed TypeScript/JavaScript file and lists every mutant the shared
 * operator set defines (see `operators.ts`). Only real syntax nodes are
 * mutated — never comments, strings or type annotations — and each mutant
 * replaces one contiguous span of the original text.
 */
export class MutantGenerator {
  generate(sourceFile: ts.SourceFile, reportedPath: string): MutantSite[] {
    const sites: MutantSite[] = [];
    const emit: Emit = (operator, start, end, replacement) => {
      sites.push({
        file: reportedPath,
        ...position(sourceFile, start),
        operator,
        original: sourceFile.text.slice(start, end),
        replacement,
        start,
        end,
      });
    };
    walk(sourceFile, sourceFile, emit);
    return sites;
  }
}

function walk(node: ts.Node, sourceFile: ts.SourceFile, emit: Emit): void {
  // Types carry no runtime behaviour: `let x: true`, `type N = -1`.
  if (ts.isTypeNode(node)) return;
  visitNode(node, sourceFile, emit);
  ts.forEachChild(node, (child) => walk(child, sourceFile, emit));
}

function visitNode(node: ts.Node, sourceFile: ts.SourceFile, emit: Emit): void {
  if (ts.isBinaryExpression(node)) {
    binaryMutants(node, sourceFile, emit);
  } else if (ts.isPrefixUnaryExpression(node)) {
    prefixMutants(node, sourceFile, emit);
  } else if (ts.isPostfixUnaryExpression(node)) {
    const end = node.getEnd();
    emit("increment", end - 2, end, node.operator === K.PlusPlusToken ? "--" : "++");
  } else if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword) {
    emit("boolean_literal", node.getStart(sourceFile), node.getEnd(), node.kind === K.TrueKeyword ? "false" : "true");
  } else if (ts.isExpressionStatement(node)) {
    callStatementMutant(node, sourceFile, emit);
  }
}

function binaryMutants(node: ts.BinaryExpression, sourceFile: ts.SourceFile, emit: Emit): void {
  const kind = node.operatorToken.kind;
  const start = node.operatorToken.getStart(sourceFile);
  const end = node.operatorToken.getEnd();
  const arithmetic = ARITHMETIC.get(kind);
  if (arithmetic !== undefined && !isStringConcatenation(node)) emit("arithmetic", start, end, arithmetic);
  const boundary = BOUNDARY.get(kind);
  if (boundary !== undefined) emit("boundary", start, end, boundary);
  const negated = NEGATE_CONDITIONAL.get(kind);
  if (negated !== undefined) emit("negate_conditional", start, end, negated);
  const logical = LOGICAL.get(kind);
  if (logical !== undefined) emit("logical", start, end, logical);
}

function prefixMutants(node: ts.PrefixUnaryExpression, sourceFile: ts.SourceFile, emit: Emit): void {
  const start = node.getStart(sourceFile);
  switch (node.operator) {
    case K.ExclamationToken:
      emit("remove_not", start, start + 1, removal(sourceFile.text, start, start + 1));
      break;
    case K.MinusToken:
      emit("invert_negative", start, start + 1, removal(sourceFile.text, start, start + 1));
      break;
    case K.PlusPlusToken:
      emit("increment", start, start + 2, "--");
      break;
    case K.MinusMinusToken:
      emit("increment", start, start + 2, "++");
      break;
  }
}

/**
 * Replacement for a removed token: empty, or one space when the removal would
 * join two identifier characters (`return!x` must not become `returnx`).
 */
function removal(text: string, start: number, end: number): string {
  return isIdentifierChar(text[start - 1]) && isIdentifierChar(text[end]) ? " " : "";
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_$]/u.test(ch);
}

/** `+` / `+=` joining strings is concatenation, not arithmetic. */
function isStringConcatenation(node: ts.BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  if (kind !== K.PlusToken && kind !== K.PlusEqualsToken) return false;
  return isStringy(node.left) || isStringy(node.right);
}

function isStringy(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isStringy(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return true;
  }
  return ts.isBinaryExpression(node) && isStringConcatenation(node);
}

/**
 * `remove_call`: a statement that is nothing but a call (optionally awaited),
 * directly inside a block or statement list, becomes an empty statement `;`.
 */
function callStatementMutant(node: ts.ExpressionStatement, sourceFile: ts.SourceFile, emit: Emit): void {
  if (!STATEMENT_LISTS.has(node.parent.kind)) return;
  const call = unwrapCall(node.expression);
  if (call === null || isSkippedCall(call)) return;
  emit("remove_call", node.getStart(sourceFile), node.getEnd(), ";");
}

function unwrapCall(expression: ts.Expression): ts.CallExpression | null {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
    current = current.expression;
  }
  return ts.isCallExpression(current) ? current : null;
}

/** Constructor delegation, dynamic imports and console output are never removed. */
function isSkippedCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === K.SuperKeyword || callee.kind === K.ImportKeyword) return true;
  let root: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
    root = root.expression;
  }
  return ts.isIdentifier(root) && root.text === "console";
}

/** 1-based line and code-point column of a source offset. */
function position(sourceFile: ts.SourceFile, offset: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  const prefix = sourceFile.text.slice(offset - character, offset);
  return { line: line + 1, column: Array.from(prefix).length + 1 };
}
