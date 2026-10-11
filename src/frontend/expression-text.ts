// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * An initial value kept as ST text (a library manifest's parameter default)
 * read back into an expression.
 */

import type { Expression } from "./ast.js";
import { buildAST } from "./ast-builder.js";
import { parse } from "./parser.js";

/** The expression `text` spells, or undefined when it does not parse. */
export function parseInitialValueText(text: string): Expression | undefined {
  const { cst, errors } = parse(
    `PROGRAM __INIT VAR __V : INT := ${text}; END_VAR END_PROGRAM`,
  );
  if (!cst || errors.length > 0) return undefined;
  const decl = buildAST(cst).programs[0]?.varBlocks[0]?.declarations[0];
  return decl?.initialValue;
}
