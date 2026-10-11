// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Interface relations (IEC 61131-3 Ed.3 6.6.6): the prototypes an interface
 * holds through EXTENDS, and which function blocks implement which
 * interfaces. Shared by the semantic passes and the code generator.
 */

import type {
  CompilationUnit,
  FunctionBlockDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
} from "../frontend/ast.js";

/**
 * The interface declared as `name`, in the compilation unit or in a library
 * it is compiled against (`libraryInterfaces`).
 */
export function findInterface(
  ast: CompilationUnit,
  name: string,
): InterfaceDeclaration | undefined {
  const upper = name.toUpperCase();
  return (
    ast.interfaces.find((i) => i.name.toUpperCase() === upper) ??
    ast.libraryInterfaces?.find((i) => i.name.toUpperCase() === upper)
  );
}

/**
 * The function block declared as `name`, in the compilation unit or — its
 * EXTENDS, IMPLEMENTS and public method prototypes only — in a library
 * (`libraryFunctionBlocks`).
 */
export function findFunctionBlock(
  ast: CompilationUnit,
  name: string,
): FunctionBlockDeclaration | undefined {
  const upper = name.toUpperCase();
  return (
    ast.functionBlocks.find((f) => f.name.toUpperCase() === upper) ??
    ast.libraryFunctionBlocks?.find((f) => f.name.toUpperCase() === upper)
  );
}

/**
 * The interfaces named and every interface they EXTEND, directly or not
 * (6.6.6.6.1 rule 4), upper case.
 */
export function interfaceClosure(
  ast: CompilationUnit,
  names: readonly string[],
): string[] {
  const out: string[] = [];
  const visit = (name: string): void => {
    const upper = name.toUpperCase();
    if (out.includes(upper)) return;
    out.push(upper);
    for (const base of findInterface(ast, upper)?.extends ?? []) visit(base);
  };
  for (const name of names) visit(name);
  return out;
}

/**
 * The interfaces a function block implements: those it and the blocks it
 * EXTENDS name in IMPLEMENTS, with everything those EXTEND, upper case.
 */
export function fbInterfaces(ast: CompilationUnit, fbName: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = fbName;
  while (current !== undefined && !seen.has(current.toUpperCase())) {
    const upper: string = current.toUpperCase();
    seen.add(upper);
    const fb = findFunctionBlock(ast, upper);
    if (!fb) break;
    names.push(...(fb.implements ?? []));
    current = fb.extends;
  }
  return interfaceClosure(ast, names);
}

/**
 * Whether a value of type `source` (a function block or an interface) may
 * be assigned to a variable of interface `target` (6.6.6.5.1 items 1-3).
 */
export function implementsInterface(
  ast: CompilationUnit,
  source: string,
  target: string,
): boolean {
  const wanted = target.toUpperCase();
  if (findInterface(ast, source)) {
    return interfaceClosure(ast, [source]).includes(wanted);
  }
  return fbInterfaces(ast, source).includes(wanted);
}

/**
 * The method prototypes of an interface: its own and those inherited through
 * EXTENDS (IEC 61131-3 6.6.6.6.1), each with the interface declaring it.
 */
export function interfacePrototypes(
  ast: CompilationUnit,
  name: string,
): Array<{ owner: string; method: MethodDeclaration }> {
  const out: Array<{ owner: string; method: MethodDeclaration }> = [];
  const seen = new Set<string>();
  const visit = (n: string): void => {
    const upper = n.toUpperCase();
    if (seen.has(upper)) return;
    seen.add(upper);
    const iface = findInterface(ast, upper);
    if (!iface) return;
    for (const m of iface.methods) out.push({ owner: iface.name, method: m });
    for (const base of iface.extends ?? []) visit(base);
  };
  visit(name);
  return out;
}

/** Whether an interface reaches itself through EXTENDS (6.6.6.6.2 item 2). */
export function interfaceExtendsItself(
  ast: CompilationUnit,
  name: string,
): boolean {
  const start = name.toUpperCase();
  const seen = new Set<string>();
  const stack = [
    ...(ast.interfaces.find((i) => i.name.toUpperCase() === start)?.extends ??
      []),
  ];
  while (stack.length > 0) {
    const upper = stack.pop()!.toUpperCase();
    if (upper === start) return true;
    if (seen.has(upper)) continue;
    seen.add(upper);
    const iface = ast.interfaces.find((i) => i.name.toUpperCase() === upper);
    stack.push(...(iface?.extends ?? []));
  }
  return false;
}

/**
 * Upper-cased names of every method a function block has: its own, those of
 * the blocks it EXTENDS, and the prototypes of every interface it implements,
 * directly, through an interface's EXTENDS or through a base block. A member
 * of the block named like any of them is refused in source (declaration-names,
 * IEC 61131-3 6.6.5.5.5 rule 2) and mangled in C++ (member-mangling rule 2),
 * which a library archive's `cppName` may still carry.
 */
export function fbMethodNames(
  ast: CompilationUnit,
  fbName: string,
): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  let current: string | undefined = fbName;
  while (current !== undefined && !seen.has(current.toUpperCase())) {
    const upper: string = current.toUpperCase();
    seen.add(upper);
    const fb = findFunctionBlock(ast, upper);
    if (!fb) break;
    for (const m of fb.methods) names.add(m.name.toUpperCase());
    current = fb.extends;
  }
  for (const iface of fbInterfaces(ast, fbName)) {
    for (const p of interfacePrototypes(ast, iface)) {
      names.add(p.method.name.toUpperCase());
    }
  }
  return names;
}
