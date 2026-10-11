// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * The one rule for renaming a C++ member whose ST name would not survive
 * translation.
 *
 * Two collisions force a trailing underscore:
 *
 *   1. **The member's name matches its own type's name.** CODESYS allows
 *      `RunningLights : RunningLights` and real projects use it, but GCC rejects
 *      a member that changes the meaning of its type name within the class
 *      (`-Wchanges-meaning`), so it is emitted as `RUNNINGLIGHTS_`.
 *
 *   2. **The member's name matches a method of the owning FB**: its own, one
 *      it inherits through EXTENDS, or a prototype of any interface it
 *      implements, inherited ones included (see {@link fbMethodNames}).
 *      `VAR Start : BOOL` beside `METHOD Start` would otherwise redeclare the
 *      method as a data member. Source declaring such a pair is refused
 *      (`semantic/declaration-names`, IEC 61131-3 6.6.5.5.5 rule 2); the rule
 *      still serves library archives built before that check, whose manifests
 *      carry the renamed pins as `cppName`.
 *
 * Every emitter that writes or addresses a member has to agree, because they all
 * name the same C++ entity: the class definition (`codegen` / `type-codegen`),
 * body expressions (`codegen` / `test-codegen`), and the debugger's pointer
 * table (`debug-table-gen`). The rule previously existed as five copies with
 * three different conditions; the debug table drifting from the class definition
 * broke the build of any project using the pattern, and only in a full firmware
 * build, since `strucpp file.st` emits no debug table.
 *
 * Callers differ in what they can resolve, so both inputs arrive through
 * {@link MemberManglingContext} rather than being computed here.
 */

import type { CompilationUnit } from "../frontend/ast.js";
import { fbMethodNames } from "../semantic/interface-utils.js";

export { fbMethodNames };

/**
 * Upper-cased names of every user-defined type in a compilation unit — function
 * blocks, interfaces, TYPE declarations, and programs, matching what
 * `CodeGenerator.isUserDefinedType` recognises.
 *
 * For emitters that have only the AST. It cannot see library-declared types, so
 * anything holding symbol tables should consult those as well; no elementary
 * name can appear here, since redeclaring one is an error.
 */
export function userDefinedTypeNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  for (const fb of ast.functionBlocks) names.add(fb.name.toUpperCase());
  for (const iface of ast.interfaces) names.add(iface.name.toUpperCase());
  for (const type of ast.types) names.add(type.name.toUpperCase());
  for (const prog of ast.programs) names.add(prog.name.toUpperCase());
  return names;
}

/**
 * What the rule needs to know, supplied by each emitter from whatever it has:
 * codegen from its `known*Types` sets, the debug table from the symbol tables
 * and AST.
 */
export interface MemberManglingContext {
  /**
   * True when `typeName` is a user-defined type — function block, interface,
   * STRUCT/UDT, or program.
   *
   * Must be false for elementary types. `Time : TIME` is an ordinary
   * declaration that codegen emits unmangled, so mangling it would name a
   * `TIME_` member that does not exist.
   */
  isUserDefinedType(typeName: string): boolean;

  /**
   * Upper-cased method names of every interface implemented by the type that
   * *declares* the member — not the member's own type. Omitted where the caller
   * has no owner in hand, which skips that check rather than guessing.
   */
  interfaceMethods?: ReadonlySet<string> | undefined;
}

/**
 * Whether a member needs the trailing underscore. See the module comment for the
 * two collisions.
 *
 * `memberTypeName` is the member's declared ST type; undefined where the caller
 * cannot resolve it, which skips the type-collision check.
 */
export function needsMemberMangling(
  memberName: string,
  memberTypeName: string | undefined,
  ctx: MemberManglingContext,
): boolean {
  const upperMember = memberName.toUpperCase();

  if (
    memberTypeName !== undefined &&
    memberTypeName !== "" &&
    upperMember === memberTypeName.toUpperCase() &&
    ctx.isUserDefinedType(memberTypeName)
  ) {
    return true;
  }

  return ctx.interfaceMethods?.has(upperMember) === true;
}

/** The member's C++ name: {@link needsMemberMangling} applied. */
export function mangledMemberName(
  memberName: string,
  memberTypeName: string | undefined,
  ctx: MemberManglingContext,
): string {
  return needsMemberMangling(memberName, memberTypeName, ctx)
    ? `${memberName}_`
    : memberName;
}

/** {@link fbMethodNames} of every block of the unit that has a method. */
export function fbMethodNamesByBlock(
  ast: CompilationUnit,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const fb of ast.functionBlocks) {
    const names = fbMethodNames(ast, fb.name);
    if (names.size > 0) out.set(fb.name.toUpperCase(), names);
  }
  return out;
}
