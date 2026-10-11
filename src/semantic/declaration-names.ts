// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Rules on the names of declared elements (IEC 61131-3 Ed.3):
 *
 * - 6.1.3: a keyword "shall not be used for any other purpose, for example,
 *   variable names". The elementary data type names are keywords (Table 10,
 *   "Keyword" column), so `time : TIME` or `Word : WORD` is an error even
 *   though the lexer reads those words as identifiers.
 * - 6.1.2: identifiers are case-insensitive, so two elements of one scope
 *   whose names differ only in letter case have the same name. Variables
 *   are checked by the symbol table; this adds structure elements,
 *   enumerated values and methods.
 * - 6.6.5.5.5 rule 2 (and 6.6.7.2.9 for function blocks): a method shall not
 *   have the name of a variable of the block. A derived block's method named
 *   like a base variable is checked in fb-rules; this checks a block's own
 *   variables, where `VAR Ready` beside `METHOD Ready` made every `Ready` in
 *   the block read the variable instead of calling the method.
 *
 * Standard function and function block names are not keywords (Annex A
 * `Std_Func_Name`, `Std_FB_Name` are names, not reserved words): LIMIT, MAX or
 * SET stay legal variable names.
 */

import type {
  CompilationUnit,
  FunctionBlockDeclaration,
  MethodDeclaration,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import type { SourceSpan } from "../types.js";
import { fbMethodNames } from "./interface-utils.js";

export interface DeclarationNameError {
  message: string;
  span: SourceSpan;
}

/** Elementary data type keywords, IEC 61131-3 Table 10. */
const ELEMENTARY_TYPE_KEYWORDS = [
  "BOOL",
  "SINT",
  "INT",
  "DINT",
  "LINT",
  "USINT",
  "UINT",
  "UDINT",
  "ULINT",
  "REAL",
  "LREAL",
  "TIME",
  "LTIME",
  "DATE",
  "LDATE",
  "TIME_OF_DAY",
  "TOD",
  "LTIME_OF_DAY",
  "LTOD",
  "DATE_AND_TIME",
  "DT",
  "LDATE_AND_TIME",
  "LDT",
  "STRING",
  "WSTRING",
  "CHAR",
  "WCHAR",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
];

/** Generic data type names, IEC 61131-3 Figure 5. */
const GENERIC_TYPE_KEYWORDS = [
  "ANY",
  "ANY_DERIVED",
  "ANY_ELEMENTARY",
  "ANY_MAGNITUDE",
  "ANY_NUM",
  "ANY_REAL",
  "ANY_INT",
  "ANY_UNSIGNED",
  "ANY_SIGNED",
  "ANY_DURATION",
  "ANY_BIT",
  "ANY_CHARS",
  "ANY_STRING",
  "ANY_CHAR",
  "ANY_DATE",
];

/**
 * The keywords of the textual language elements (the quoted terminals of
 * Annex A that are not standard function, function block or IL operator
 * names). Two groups are left out:
 *
 * - the SFC keywords (6.7: STEP, INITIAL_STEP, TRANSITION, ACTION, FROM and
 *   their END_ forms): STruC++ has no textual SFC, and OSCAT, a bundled
 *   CODESYS library, names variables and inputs STEP (COUNT_BR, SEQUENCE_8);
 * - R_EDGE and F_EDGE, which the parser reads as qualifiers only after BOOL
 *   so that they stay usable as names, as OSCAT does (MANUAL_1);
 * - ON, ABSTRACT, FINAL and OVERRIDE, which the parser's identifierOrKeyword
 *   rule admits as names for CODESYS compatibility (OSCAT has a function
 *   OVERRIDE).
 */
const LANGUAGE_KEYWORDS = [
  "AND",
  "ARRAY",
  "AT",
  "BY",
  "CASE",
  "CLASS",
  "CONFIGURATION",
  "CONSTANT",
  "CONTINUE",
  "DO",
  "ELSE",
  "ELSIF",
  "END_CASE",
  "END_CLASS",
  "END_CONFIGURATION",
  "END_FOR",
  "END_FUNCTION",
  "END_FUNCTION_BLOCK",
  "END_IF",
  "END_INTERFACE",
  "END_METHOD",
  "END_NAMESPACE",
  "END_PROGRAM",
  "END_REPEAT",
  "END_RESOURCE",
  "END_STRUCT",
  "END_TYPE",
  "END_VAR",
  "END_WHILE",
  "EXIT",
  "EXTENDS",
  "FALSE",
  "FOR",
  "FUNCTION",
  "FUNCTION_BLOCK",
  "IF",
  "IMPLEMENTS",
  "INTERFACE",
  "INTERNAL",
  "INTERVAL",
  "METHOD",
  "MOD",
  "NAMESPACE",
  "NON_RETAIN",
  "NOT",
  "NULL",
  "OF",
  "OR",
  "OVERLAP",
  "PRIORITY",
  "PRIVATE",
  "PROGRAM",
  "PROTECTED",
  "PUBLIC",
  "READ_ONLY",
  "READ_WRITE",
  "REF",
  "REF_TO",
  "REPEAT",
  "RESOURCE",
  "RETAIN",
  "RETURN",
  "SINGLE",
  "STRUCT",
  "SUPER",
  "TASK",
  "THEN",
  "THIS",
  "TO",
  "TRUE",
  "TYPE",
  "UNTIL",
  "USING",
  "VAR",
  "VAR_ACCESS",
  "VAR_CONFIG",
  "VAR_EXTERNAL",
  "VAR_GLOBAL",
  "VAR_IN_OUT",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_TEMP",
  "WHILE",
  "WITH",
  "XOR",
];

const KEYWORDS: ReadonlySet<string> = new Set([
  ...ELEMENTARY_TYPE_KEYWORDS,
  ...GENERIC_TYPE_KEYWORDS,
  ...LANGUAGE_KEYWORDS,
]);

/** Whether `name` is an IEC 61131-3 keyword (6.1.3), in any letter case. */
export function isIecKeyword(name: string): boolean {
  return KEYWORDS.has(name.toUpperCase());
}

export function checkDeclarationNames(
  ast: CompilationUnit,
): DeclarationNameError[] {
  const errors: DeclarationNameError[] = [];
  const err = (message: string, span: SourceSpan): void => {
    errors.push({ message, span });
  };

  const keyword = (name: string, what: string, span: SourceSpan): void => {
    if (!isIecKeyword(name)) return;
    err(
      `'${name}' is a keyword and cannot be used as ${what} name (IEC 61131-3 6.1.3${ELEMENTARY_TYPE_KEYWORDS.includes(name.toUpperCase()) ? ", Table 10" : ""})`,
      span,
    );
  };

  /** The declared spelling of each name of a declaration, with its span. */
  const namesOf = (
    decl: VarDeclaration,
  ): Array<{ name: string; span: SourceSpan }> =>
    decl.names.map((n, i) => ({
      name: decl.declaredNames?.[i] ?? n,
      span: nameSpan(decl, i),
    }));

  const varBlocks = (blocks: readonly VarBlock[]): void => {
    for (const block of blocks) {
      for (const decl of block.declarations) {
        for (const { name, span } of namesOf(decl)) {
          keyword(name, "a variable", span);
        }
      }
    }
  };

  const method = (m: MethodDeclaration): void => {
    keyword(m.name, "a method", m.sourceSpan);
    varBlocks(m.varBlocks);
  };

  for (const prog of ast.programs) {
    keyword(prog.name, "a program", prog.sourceSpan);
    varBlocks(prog.varBlocks);
  }
  for (const func of ast.functions) {
    keyword(func.name, "a function", func.sourceSpan);
    varBlocks(func.varBlocks);
  }
  for (const fb of ast.functionBlocks) {
    keyword(fb.name, "a function block", fb.sourceSpan);
    varBlocks(fb.varBlocks);
    for (const m of fb.methods) method(m);
    for (const p of fb.properties) keyword(p.name, "a property", p.sourceSpan);
    checkMembers(ast, fb, err);
  }
  for (const iface of ast.interfaces) {
    keyword(iface.name, "an interface", iface.sourceSpan);
    for (const m of iface.methods) method(m);
  }
  varBlocks(ast.globalVarBlocks);
  for (const config of ast.configurations) {
    keyword(config.name, "a configuration", config.sourceSpan);
    varBlocks(config.varBlocks);
  }

  for (const type of ast.types) {
    // A hoisted inline type is named after its variable; that name is checked there.
    if (!type.inline) {
      keyword(type.declaredName ?? type.name, "a data type", type.sourceSpan);
    }
    const def = type.definition;
    if (def.kind === "StructDefinition") {
      const seen = new Set<string>();
      for (const field of def.fields) {
        for (const { name, span } of namesOf(field)) {
          keyword(name, "a structure element", span);
          const upper = name.toUpperCase();
          if (seen.has(upper)) {
            err(
              `Structure element '${name}' is already declared in '${type.declaredName ?? type.name}': identifiers are case-insensitive (IEC 61131-3 6.1.2)`,
              span,
            );
          }
          seen.add(upper);
        }
      }
    } else if (def.kind === "EnumDefinition") {
      const seen = new Set<string>();
      for (const member of def.members) {
        keyword(member.name, "an enumerated value", member.sourceSpan);
        const upper = member.name.toUpperCase();
        if (seen.has(upper)) {
          err(
            `Enumerated value '${member.name}' is already declared in '${type.declaredName ?? type.name}': identifiers are case-insensitive (IEC 61131-3 6.1.2)`,
            member.sourceSpan,
          );
        }
        seen.add(upper);
      }
    }
  }
  return errors;
}

/** The span of a declaration's i-th name, in the declaration's file. */
function nameSpan(decl: VarDeclaration, i: number): SourceSpan {
  const own = decl.nameSpans?.[i];
  if (own === undefined) return decl.sourceSpan;
  return own.file ? own : { ...own, file: decl.sourceSpan.file };
}

/**
 * A block's methods against each other, and its variables against every
 * method it has: its own, inherited and those of the interfaces it implements
 * (6.1.2; 6.6.5.5.5 rule 2, which forbids a method named like a variable of
 * the base, applies all the more to a variable of the block itself).
 */
function checkMembers(
  ast: CompilationUnit,
  fb: FunctionBlockDeclaration,
  err: (message: string, span: SourceSpan) => void,
): void {
  const methods = new Set<string>();
  for (const m of fb.methods) {
    const upper = m.name.toUpperCase();
    if (methods.has(upper)) {
      err(
        `Method '${m.name}' is already declared in '${fb.name}': identifiers are case-insensitive and methods cannot be overloaded (IEC 61131-3 6.1.2, 6.6.5.4.3 NOTE 1)`,
        m.sourceSpan,
      );
    }
    methods.add(upper);
  }
  const all = fbMethodNames(ast, fb.name);
  if (all.size === 0) return;
  for (const block of fb.varBlocks) {
    for (const decl of block.declarations) {
      decl.names.forEach((n, i) => {
        if (!all.has(n.toUpperCase())) return;
        const name = decl.declaredNames?.[i] ?? n;
        err(
          `Variable '${name}' of '${fb.name}' has the name of a method of the block: a variable and a method of one block cannot share a name, or the name would read the variable and never call the method (IEC 61131-3 6.1.2, 6.6.5.5.5 rule 2)`,
          nameSpan(decl, i),
        );
      });
    }
  }
}
