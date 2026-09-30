import { SlopguardError } from "../errors.js";

/**
 * Mutation operator ids. The same ids are used by every slopguard port — in
 * `--operators`, in the JSON `operator` field, and in ignore markers — so keep
 * them in step with the siblings.
 *
 * - `arithmetic` — `+`↔`-`, `*`↔`/`, `%`→`*` and the compound assignments.
 * - `boolean_literal` — `true`↔`false`.
 * - `boundary` — `<`↔`<=`, `>`↔`>=`.
 * - `increment` — `++`↔`--`.
 * - `invert_negative` — `-x` → `x`.
 * - `logical` — `&&`↔`||`.
 * - `negate_conditional` — `==`↔`!=`, `===`↔`!==`, `<`→`>=`, `<=`→`>`, `>`→`<=`, `>=`→`<`.
 * - `remove_call` — drop a call statement whose result is discarded.
 * - `remove_not` — `!x` → `x`.
 */
export type MutationOperator =
  | "arithmetic"
  | "boolean_literal"
  | "boundary"
  | "increment"
  | "invert_negative"
  | "logical"
  | "negate_conditional"
  | "remove_call"
  | "remove_not";

/** Every operator, sorted. The default when `--operators` is not given. */
export const MUTATION_OPERATORS: readonly MutationOperator[] = [
  "arithmetic",
  "boolean_literal",
  "boundary",
  "increment",
  "invert_negative",
  "logical",
  "negate_conditional",
  "remove_call",
  "remove_not",
];

export function isMutationOperator(value: string): value is MutationOperator {
  return (MUTATION_OPERATORS as readonly string[]).includes(value);
}

/**
 * Resolve `--operators` values (comma-separated, and the flag may repeat) into
 * a sorted, de-duplicated list. No ids at all means every operator.
 */
export function parseOperators(values: readonly string[]): MutationOperator[] {
  const ids = values
    .flatMap((value) => value.split(","))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) return [...MUTATION_OPERATORS];
  const unknown = ids.filter((id) => !isMutationOperator(id));
  if (unknown.length > 0) {
    throw SlopguardError.invalidArgument(
      "--operators",
      `unknown operator(s): ${unknown.join(", ")} (expected: ${MUTATION_OPERATORS.join(", ")})`
    );
  }
  return MUTATION_OPERATORS.filter((operator) => ids.includes(operator));
}
