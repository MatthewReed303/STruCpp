// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Type Default Propagation
 *
 * IEC 61131-3 Annex B.1.3.3 lets a TYPE declaration carry its own default
 * value — `initialized_simple_type_declaration`, `initialized_structure` and
 * `initialized_array_type_declaration`:
 *
 *   TYPE
 *     Setpoint : REAL := 25.0;
 *     Origin   : Point := (x := 0.0, y := 0.0);
 *     Light    : (RED, GREEN) := GREEN;
 *   END_TYPE
 *
 * Every declaration of such a type that does not supply its own initialiser
 * starts from the type's default. An enumerated type or a data type with
 * named values without one starts from the first element of its list
 * (6.4.4.2.2, 6.4.4.3.2); that matters when the first element has an explicit
 * value, since the C++ enumeration otherwise starts at zero. An array whose
 * element type has a default starts with every element at it, whether the
 * array is written inline (`ARRAY[1..3] OF E`) or is a TYPE of its own. Rather than teaching each of the many
 * declaration paths (globals, PROGRAM/FB/FUNCTION locals, struct fields …) about
 * type defaults, this single pass copies the default onto those declarations
 * right after the AST is built, so every downstream consumer — semantic
 * analysis, the project model, codegen — sees an ordinary initialiser.
 */

import type {
  ArrayDefinition,
  ArrayLiteralExpression,
  CompilationUnit,
  EnumDefinition,
  Expression,
  TypeDeclaration,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "./ast.js";
import { walkAST } from "../ast-utils.js";

/** Guard against a cyclic alias chain (`TYPE A : B; B : A; END_TYPE`). */
const MAX_ALIAS_DEPTH = 32;

/**
 * Largest array filled with its element default, the same bound as an array
 * repetition `[N(value)]` (the initialiser is spelled out element by element).
 */
const MAX_FILLED_ELEMENTS = 65536;

/** The qualified enumerated value `type#member` (6.4.4.3: unambiguous). */
export function qualifiedEnumValue(
  typeName: string,
  member: string,
  sourceSpan: VariableExpression["sourceSpan"],
): VariableExpression {
  return {
    kind: "VariableExpression",
    sourceSpan,
    name: typeName,
    subscripts: [],
    fieldAccess: [member],
    accessChain: [{ kind: "field", name: member }],
    isDereference: false,
    typedLiteral: true,
  };
}

/**
 * The implicit default of an enumeration whose first element has an explicit
 * value: that element (IEC 61131-3 6.4.4.2.2, 6.4.4.3.2). Without an explicit
 * value the first element is the C++ enumeration's zero already.
 */
function firstElementDefault(td: TypeDeclaration): Expression | undefined {
  const def = td.definition as EnumDefinition;
  if (def.kind !== "EnumDefinition") return undefined;
  const first = def.members[0];
  if (first?.value === undefined) return undefined;
  return qualifiedEnumValue(td.name, first.name, first.sourceSpan);
}

/** Element count of fixed numeric bounds, or undefined. */
function elementCount(
  dims: ReadonlyArray<{ start: number; end: number }>,
): number | undefined {
  let count = 1;
  for (const { start, end } of dims) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      return undefined;
    }
    count *= end - start + 1;
  }
  return count > 0 && count <= MAX_FILLED_ELEMENTS ? count : undefined;
}

/** Numeric bounds of a TYPE's array dimensions, when they are literals. */
function definitionBounds(
  def: ArrayDefinition,
): Array<{ start: number; end: number }> | undefined {
  const value = (e: Expression | undefined): number | undefined => {
    if (e?.kind === "LiteralExpression" && typeof e.value === "number") {
      return e.value;
    }
    if (
      e?.kind === "UnaryExpression" &&
      e.operator === "-" &&
      e.operand.kind === "LiteralExpression" &&
      typeof e.operand.value === "number"
    ) {
      return -e.operand.value;
    }
    return undefined;
  };
  const out: Array<{ start: number; end: number }> = [];
  for (const d of def.dimensions) {
    const start = value(d.start);
    const end = value(d.end);
    if (d.isVariableLength || start === undefined || end === undefined) {
      return undefined;
    }
    out.push({ start, end });
  }
  return out;
}

/** `count` copies of `element` as an array initialiser. */
function filled(element: Expression, count: number): ArrayLiteralExpression {
  return {
    kind: "ArrayLiteralExpression",
    sourceSpan: element.sourceSpan,
    elements: Array.from({ length: count }, () => element),
  };
}

/**
 * Copy TYPE-level default values onto every declaration of those types that
 * lacks its own initialiser. Mutates `unit` in place.
 *
 * `external` adds the defaults of types declared elsewhere — a library's,
 * from its manifest — by upper-case type name.
 *
 * Idempotent: a declaration that already has an initialiser is never touched,
 * so running the pass again (for instance on a merged multi-file unit) is safe.
 */
export function applyTypeDefaults(
  unit: CompilationUnit,
  external?: ReadonlyMap<string, Expression>,
): void {
  const defaults = new Map<string, Expression>(external ?? []);
  /** Alias target of each type, for chains like `Celsius : Setpoint;`. */
  const aliasTargets = new Map<string, string>();
  const arrayTypes: Array<[string, ArrayDefinition]> = [];

  for (const td of unit.types) {
    const key = td.name.toUpperCase();
    const own = td.defaultValue ?? firstElementDefault(td);
    if (own) defaults.set(key, own);
    if (td.definition.kind === "TypeReference") {
      aliasTargets.set(key, td.definition.name.toUpperCase());
    } else if (td.definition.kind === "ArrayDefinition" && !own) {
      arrayTypes.push([key, td.definition]);
    }
  }
  // An array TYPE without a default of its own: every element at the
  // element type's default. Repeated so an array of such an array resolves.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, def] of arrayTypes) {
      if (defaults.has(key)) continue;
      const element = resolveDefault(
        def.elementType.name,
        defaults,
        aliasTargets,
      );
      const bounds = definitionBounds(def);
      const count = bounds && elementCount(bounds);
      if (element && count) {
        defaults.set(key, filled(element, count));
        changed = true;
      }
    }
  }
  if (defaults.size === 0) return;

  walkAST(unit, (node): boolean => {
    // VAR_EXTERNAL names a global declared elsewhere and VAR_IN_OUT is bound by
    // the caller; neither owns storage to initialise.
    if (node.kind === "VarBlock") {
      const block = node as VarBlock;
      return (
        block.blockType !== "VAR_EXTERNAL" && block.blockType !== "VAR_IN_OUT"
      );
    }
    if (node.kind !== "VarDeclaration") return true;

    const decl = node as VarDeclaration;
    // A reference binds to existing storage — it has no value of its own.
    if (
      decl.initialValue === undefined &&
      (!decl.type.referenceKind || decl.type.referenceKind === "none")
    ) {
      const defaultValue =
        resolveDefault(decl.type.name, defaults, aliasTargets) ??
        inlineArrayDefault(decl, defaults, aliasTargets);
      if (defaultValue) decl.initialValue = defaultValue;
    }
    return true;
  });
}

/** `ARRAY[..] OF T` written inline, T having a default: T's default throughout. */
function inlineArrayDefault(
  decl: VarDeclaration,
  defaults: Map<string, Expression>,
  aliasTargets: Map<string, string>,
): Expression | undefined {
  const { arrayDimensions, elementTypeName, elementReferenceChain } = decl.type;
  if (!arrayDimensions || !elementTypeName || elementReferenceChain) {
    return undefined;
  }
  const element = resolveDefault(elementTypeName, defaults, aliasTargets);
  const count = element && elementCount(arrayDimensions);
  return element && count ? filled(element, count) : undefined;
}

/**
 * Find the default for `typeName`, following alias chains until one is found.
 */
function resolveDefault(
  typeName: string,
  defaults: Map<string, Expression>,
  aliasTargets: Map<string, string>,
): Expression | undefined {
  let current = typeName.toUpperCase();
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
    const own = defaults.get(current);
    if (own !== undefined) return own;
    const target = aliasTargets.get(current);
    if (target === undefined || target === current) return undefined;
    current = target;
  }
  return undefined;
}
