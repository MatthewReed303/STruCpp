// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * Function block rules checked on the AST (IEC 61131-3 Ed.3):
 *
 * - inheritance: EXTENDS, SUPER(), OVERRIDE, ABSTRACT, access specifiers
 *   (6.6.5.5 - 6.6.5.10, 6.6.7.2.5 - 6.6.7.2.11, 6.6.8.3);
 * - edge inputs `BOOL R_EDGE` / `BOOL F_EDGE` (6.6.3.2 item 13, Annex A
 *   `Edge_Decl`);
 * - temporaries, which live for one call only (6.5.2.1, 6.6.3.2 item 17,
 *   6.6.7.2.3 rule 4).
 *
 * A base block that is not in the compilation unit (one from a library
 * archive) is opaque here: rules that would need its declaration are skipped.
 */

import type {
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  MethodCallExpression,
  MethodDeclaration,
  Statement,
  VarBlock,
  VarDeclaration,
  VariableExpression,
  Visibility,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { SourceSpan } from "../types.js";
import { fbInterfaces, interfacePrototypes } from "./interface-utils.js";

export interface FbRuleError {
  message: string;
  span: SourceSpan;
  /**
   * A rule of the standard that CODESYS does not apply (it overrides without
   * the OVERRIDE keyword): reported as a warning so such programs still build.
   */
  warning?: true;
}

/** A variable of a block, with the section and block that declare it. */
interface DeclaredVar {
  owner: FunctionBlockDeclaration;
  block: VarBlock;
  decl: VarDeclaration;
}

/** Where a body runs: which block it belongs to, and as what. */
interface BodyContext {
  pou: "program" | "function" | "body" | "method" | "property";
  /** The block a body, method or property belongs to. */
  fb?: FunctionBlockDeclaration;
  method?: MethodDeclaration;
  stmts: Statement[];
  /** Names declared by the body itself (a method's or function's own variables). */
  own: Map<string, VarDeclaration>;
  /** Declared type of every name in reach, upper case. */
  types: Map<string, string>;
}

const LOOPS = new Set(["ForStatement", "WhileStatement", "RepeatStatement"]);

class Family {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();

  constructor(ast: CompilationUnit) {
    for (const fb of ast.functionBlocks)
      this.fbs.set(fb.name.toUpperCase(), fb);
  }

  get(name: string | undefined): FunctionBlockDeclaration | undefined {
    return name === undefined ? undefined : this.fbs.get(name.toUpperCase());
  }

  /** The block followed by the blocks it EXTENDS that are known, nearest first. */
  lineage(fb: FunctionBlockDeclaration): FunctionBlockDeclaration[] {
    const out: FunctionBlockDeclaration[] = [];
    let current: FunctionBlockDeclaration | undefined = fb;
    while (current && !out.includes(current)) {
      out.push(current);
      current = this.get(current.extends);
    }
    return out;
  }

  bases(fb: FunctionBlockDeclaration): FunctionBlockDeclaration[] {
    return this.lineage(fb).slice(1);
  }

  /** Whether `fb` is `ancestor` or derives from it. */
  isOrDerives(
    fb: FunctionBlockDeclaration,
    ancestor: FunctionBlockDeclaration,
  ): boolean {
    return this.lineage(fb).includes(ancestor);
  }

  findVar(fb: FunctionBlockDeclaration, name: string): DeclaredVar | undefined {
    const upper = name.toUpperCase();
    for (const owner of this.lineage(fb)) {
      for (const block of owner.varBlocks) {
        for (const decl of block.declarations) {
          if (decl.names.some((n) => n.toUpperCase() === upper)) {
            return { owner, block, decl };
          }
        }
      }
    }
    return undefined;
  }

  findMethod(
    fb: FunctionBlockDeclaration,
    name: string,
  ):
    | { owner: FunctionBlockDeclaration; method: MethodDeclaration }
    | undefined {
    const upper = name.toUpperCase();
    for (const owner of this.lineage(fb)) {
      const method = owner.methods.find((m) => m.name.toUpperCase() === upper);
      if (method) return { owner, method };
    }
    return undefined;
  }
}

function addNames(map: Map<string, string>, blocks: readonly VarBlock[]): void {
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const n of decl.names)
        map.set(n.toUpperCase(), decl.type.name.toUpperCase());
    }
  }
}

function ownNames(blocks: readonly VarBlock[]): Map<string, VarDeclaration> {
  const map = new Map<string, VarDeclaration>();
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const n of decl.names) map.set(n.toUpperCase(), decl);
    }
  }
  return map;
}

function bodies(ast: CompilationUnit, family: Family): BodyContext[] {
  const out: BodyContext[] = [];
  for (const prog of ast.programs) {
    const types = new Map<string, string>();
    addNames(types, prog.varBlocks);
    out.push({
      pou: "program",
      stmts: prog.body,
      own: ownNames(prog.varBlocks),
      types,
    });
  }
  for (const func of ast.functions) {
    const types = new Map<string, string>();
    addNames(types, func.varBlocks);
    out.push({
      pou: "function",
      stmts: func.body,
      own: ownNames(func.varBlocks),
      types,
    });
  }
  for (const fb of ast.functionBlocks) {
    const fbTypes = new Map<string, string>();
    for (const owner of family.lineage(fb).reverse())
      addNames(fbTypes, owner.varBlocks);
    out.push({
      pou: "body",
      fb,
      stmts: fb.body,
      own: ownNames(fb.varBlocks),
      types: fbTypes,
    });
    for (const method of fb.methods) {
      const types = new Map(fbTypes);
      addNames(types, method.varBlocks);
      out.push({
        pou: "method",
        fb,
        method,
        stmts: method.body,
        own: ownNames(method.varBlocks),
        types,
      });
    }
    for (const prop of fb.properties) {
      for (const stmts of [prop.getter, prop.setter]) {
        if (stmts) {
          out.push({
            pou: "property",
            fb,
            stmts,
            own: new Map(),
            types: fbTypes,
          });
        }
      }
    }
  }
  return out;
}

/** Each SUPER() body call in `stmts`, and whether it sits inside a loop. */
function superBodyCalls(
  stmts: readonly Statement[],
): Array<{ call: FunctionCallExpression; inLoop: boolean }> {
  const found: Array<{ call: FunctionCallExpression; inLoop: boolean }> = [];
  const visit = (node: Statement | Expression, inLoop: boolean): void => {
    walkAST(node, (n) => {
      if (n !== node && LOOPS.has(n.kind)) {
        visit(n as Statement, true);
        return false;
      }
      if (
        n.kind === "FunctionCallExpression" &&
        (n as FunctionCallExpression).functionName.toUpperCase() === "SUPER"
      ) {
        found.push({ call: n as FunctionCallExpression, inLoop });
      }
      return undefined;
    });
  };
  for (const stmt of stmts) visit(stmt, LOOPS.has(stmt.kind));
  return found;
}

/** Each `SUPER.member` / `SUPER.method()` use in `stmts`. */
function superMemberUses(stmts: readonly Statement[]): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const stmt of stmts) {
    walkAST(stmt, (n) => {
      if (
        n.kind === "FunctionCallExpression" &&
        (n as FunctionCallExpression).functionName
          .toUpperCase()
          .startsWith("SUPER.")
      ) {
        spans.push(n.sourceSpan);
      } else if (
        n.kind === "VariableExpression" &&
        (n as VariableExpression).name.toUpperCase() === "SUPER"
      ) {
        spans.push(n.sourceSpan);
      }
      return undefined;
    });
  }
  return spans;
}

const accessName = (v: Visibility): string => v;

export function checkFunctionBlockRules(
  ast: CompilationUnit,
  isFunctionBlockType: (name: string) => boolean,
): FbRuleError[] {
  const errors: FbRuleError[] = [];
  const err = (message: string, span: SourceSpan, warning?: true): void => {
    errors.push(warning ? { message, span, warning } : { message, span });
  };
  const family = new Family(ast);
  const contexts = bodies(ast, family);

  checkSectionQualifiers(ast, err);
  checkDeclarations(ast, family, isFunctionBlockType, err);
  checkSuper(contexts, err);
  checkMemberAccess(contexts, family, err);
  return errors;
}

/** Access specifiers and edge qualifiers on declarations. */
function checkSectionQualifiers(
  ast: CompilationUnit,
  err: (message: string, span: SourceSpan) => void,
): void {
  const fbBlocks = new Set<VarBlock>();
  for (const fb of ast.functionBlocks)
    for (const b of fb.varBlocks) fbBlocks.add(b);

  const visitBlocks = (
    blocks: readonly VarBlock[],
    where: "function" | "method" | "program" | "fb" | "global",
  ): void => {
    for (const block of blocks) {
      if (block.access !== undefined) {
        if (block.blockType !== "VAR" || !fbBlocks.has(block)) {
          err(
            `Access specifier ${accessName(block.access)} is allowed only on a VAR section of a FUNCTION_BLOCK, not on ${block.blockType}` +
              (where === "fb" ? "" : ` of a ${where.toUpperCase()}`) +
              ` (IEC 61131-3 6.6.5.10, 6.6.7.2.6)`,
            block.sourceSpan,
          );
        }
      }
      for (const decl of block.declarations) {
        if (decl.edge === undefined) continue;
        const span = decl.edgeSpan ?? decl.sourceSpan;
        if (block.blockType !== "VAR_INPUT") {
          err(
            `${decl.edge} qualifies an input only; '${decl.names.join(", ")}' is in ${block.blockType} (IEC 61131-3 Annex A Edge_Decl)`,
            span,
          );
        } else if (
          decl.type.name.toUpperCase() !== "BOOL" ||
          decl.type.arrayDimensions !== undefined ||
          (decl.type.referenceKind !== undefined &&
            decl.type.referenceKind !== "none")
        ) {
          err(
            `${decl.edge} applies to a BOOL input only; '${decl.names.join(", ")}' is ${decl.type.name} (IEC 61131-3 Annex A Edge_Decl)`,
            span,
          );
        } else if (decl.initialValue !== undefined) {
          err(
            `An ${decl.edge} input takes no initial value (IEC 61131-3 Annex A Edge_Decl); the edge memory starts FALSE`,
            span,
          );
        } else if (where !== "fb") {
          err(
            `${decl.edge} declares an implicit ${decl.edge === "R_EDGE" ? "R_TRIG" : "F_TRIG"} instance, which only a FUNCTION_BLOCK holds (IEC 61131-3 6.6.3.2 item 13)` +
              (where === "program"
                ? "; edge inputs on a PROGRAM are not implemented"
                : ""),
            span,
          );
        }
      }
    }
  };

  for (const prog of ast.programs) visitBlocks(prog.varBlocks, "program");
  for (const func of ast.functions) visitBlocks(func.varBlocks, "function");
  for (const fb of ast.functionBlocks) {
    visitBlocks(fb.varBlocks, "fb");
    for (const m of fb.methods) visitBlocks(m.varBlocks, "method");
  }
  for (const iface of ast.interfaces) {
    for (const m of iface.methods) visitBlocks(m.varBlocks, "method");
  }
  visitBlocks(ast.globalVarBlocks, "global");
}

/** Declaration rules of a block against the blocks it EXTENDS. */
function checkDeclarations(
  ast: CompilationUnit,
  family: Family,
  isFunctionBlockType: (name: string) => boolean,
  err: (message: string, span: SourceSpan, warning?: true) => void,
): void {
  for (const fb of ast.functionBlocks) {
    // 6.6.3.2 item 17: no function block instance among the temporaries.
    for (const block of fb.varBlocks) {
      if (block.blockType !== "VAR_TEMP") continue;
      for (const decl of block.declarations) {
        if (isFunctionBlockType(decl.type.elementTypeName ?? decl.type.name)) {
          err(
            `Function block instance '${decl.names.join(", ")}' cannot be declared in VAR_TEMP (IEC 61131-3 6.6.3.2 item 17): a temporary exists for one call only`,
            decl.sourceSpan,
          );
        }
      }
    }

    const bases = family.bases(fb);
    if (bases.length === 0) continue;

    // 6.6.7.2.9 rule 3: variable names unique across the block and its bases.
    for (const block of fb.varBlocks) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          for (const base of bases) {
            const hit = family.findVar(base, name);
            if (hit && hit.owner === base) {
              err(
                `'${name}' is already a variable of base '${base.name}': the names of the variables in a base and a derived function block shall be unique (IEC 61131-3 6.6.7.2.9 rule 3)`,
                decl.sourceSpan,
              );
              break;
            }
          }
        }
      }
    }

    const ownAbstract = fb.isAbstract;
    for (const method of fb.methods) {
      // 6.6.5.5.5 rule 2: no method with the name of a base variable.
      const asVar = bases
        .map((b) => family.findVar(b, method.name))
        .find((v) => v !== undefined);
      if (asVar) {
        err(
          `Method '${method.name}' has the name of variable '${method.name}' of base '${asVar.owner.name}' (IEC 61131-3 6.6.5.5.5 rule 2)`,
          method.sourceSpan,
        );
      }

      const inherited = bases
        .map((b) => family.findMethod(b, method.name))
        .find((m) => m !== undefined);

      if (method.isAbstract && method.isOverride) {
        err(
          `Method '${method.name}': ABSTRACT shall not be used with OVERRIDE (IEC 61131-3 6.6.5.8.3)`,
          method.sourceSpan,
        );
      }
      if (!inherited) continue;
      const base = inherited.method;
      if (base.visibility === "PRIVATE") {
        // 6.6.5.5.2 rule 1: a PRIVATE method is not inherited.
        if (method.isOverride) {
          err(
            `Method '${method.name}' of '${fb.name}' is marked OVERRIDE, but '${method.name}' of '${inherited.owner.name}' is PRIVATE and not inherited (IEC 61131-3 6.6.5.5.2 rule 1)`,
            method.sourceSpan,
          );
        }
        continue;
      }
      if (!method.isOverride && !base.isAbstract) {
        err(
          `Method '${method.name}' of '${fb.name}' replaces the method of '${inherited.owner.name}' without OVERRIDE; IEC 61131-3 6.6.5.5.3 rule 2 requires METHOD OVERRIDE`,
          method.sourceSpan,
          true,
        );
      }
      if (method.visibility !== base.visibility) {
        err(
          `Method '${method.name}' of '${fb.name}' is ${method.visibility}, but the method it replaces in '${inherited.owner.name}' is ${base.visibility}; IEC 61131-3 6.6.5.5.3 rule 2 requires the same access specifier`,
          method.sourceSpan,
          true,
        );
      }
    }

    if (ownAbstract) continue;
    // 6.6.5.8.2: a non-abstract derived block implements every inherited
    // ABSTRACT method.
    const reported = new Set<string>();
    for (const base of bases) {
      for (const m of base.methods) {
        if (!m.isAbstract) continue;
        const impl = family.findMethod(fb, m.name);
        if (impl && !impl.method.isAbstract) continue;
        const key = m.name.toUpperCase();
        if (reported.has(key)) continue;
        reported.add(key);
        err(
          `FUNCTION_BLOCK '${fb.name}' does not implement ABSTRACT method '${m.name}' of '${base.name}' (IEC 61131-3 6.6.5.8.2)`,
          fb.sourceSpan,
        );
      }
    }
    // 6.6.5.8.3 / 6.6.6.4: the prototypes of an interface a base implements
    // (those the block names itself are checked with IMPLEMENTS).
    const own = new Set((fb.implements ?? []).map((n) => n.toUpperCase()));
    for (const iface of fbInterfaces(ast, fb.name)) {
      if (own.has(iface)) continue;
      for (const proto of interfacePrototypes(ast, iface)) {
        const impl = family.findMethod(fb, proto.method.name);
        if (impl && !impl.method.isAbstract) continue;
        const key = proto.method.name.toUpperCase();
        if (reported.has(key)) continue;
        reported.add(key);
        err(
          `FUNCTION_BLOCK '${fb.name}' does not implement method '${proto.method.name}' of INTERFACE '${proto.owner}', which it inherits (IEC 61131-3 6.6.5.8.3)`,
          fb.sourceSpan,
        );
      }
    }
  }
}

/** SUPER() and SUPER.member (6.6.5.7.3, 6.6.7.2.9). */
function checkSuper(
  contexts: readonly BodyContext[],
  err: (message: string, span: SourceSpan) => void,
): void {
  for (const ctx of contexts) {
    const calls = superBodyCalls(ctx.stmts);
    if (ctx.pou !== "body") {
      for (const { call } of calls) {
        err(
          ctx.pou === "method" || ctx.pou === "property"
            ? `SUPER() may only be called in the function block body, not in a method (IEC 61131-3 6.6.7.2.9 rule 5)`
            : `SUPER() calls the body of a base function block and is allowed only in the body of a derived FUNCTION_BLOCK (IEC 61131-3 6.6.7.2.9)`,
          call.sourceSpan,
        );
      }
    } else {
      calls.forEach(({ call, inLoop }, i) => {
        if (!ctx.fb?.extends) {
          err(
            `SUPER() needs a base: '${ctx.fb?.name ?? ""}' does not EXTEND a function block (IEC 61131-3 6.6.7.2.9)`,
            call.sourceSpan,
          );
          return;
        }
        if (call.arguments.length > 0) {
          err(
            `The call of SUPER() has no parameters (IEC 61131-3 6.6.7.2.9 rule 2)`,
            call.sourceSpan,
          );
        }
        if (inLoop) {
          err(
            `SUPER() shall not be in a loop (IEC 61131-3 6.6.7.2.9 rule 2)`,
            call.sourceSpan,
          );
        } else if (i > 0) {
          err(
            `SUPER() shall occur once in the function block body (IEC 61131-3 6.6.7.2.9 rule 2)`,
            call.sourceSpan,
          );
        }
      });
    }
    if (!ctx.fb?.extends) {
      for (const span of superMemberUses(ctx.stmts)) {
        err(
          ctx.fb
            ? `SUPER needs a base: '${ctx.fb.name}' does not EXTEND a function block (IEC 61131-3 6.6.5.7.3)`
            : `SUPER is available only in a derived FUNCTION_BLOCK (IEC 61131-3 6.6.5.7.3)`,
          span,
        );
      }
    }
  }
}

/**
 * Who may reach a variable or method: the access specifiers (6.6.5.9,
 * 6.6.5.10), the temporaries of a call (6.5.2.1, 6.6.7.2.3 rule 4) and the
 * edge inputs (6.6.7.2.3 rule 3).
 */
function checkMemberAccess(
  contexts: readonly BodyContext[],
  family: Family,
  err: (message: string, span: SourceSpan) => void,
): void {
  const allowed = (
    caller: FunctionBlockDeclaration | undefined,
    owner: FunctionBlockDeclaration,
    access: Visibility | undefined,
  ): boolean => {
    if (access === undefined || access === "PUBLIC") return true;
    if (!caller) return false;
    if (access === "PRIVATE") return caller === owner;
    return family.isOrDerives(caller, owner);
  };

  for (const ctx of contexts) {
    const caller = ctx.fb;
    const reportVar = (
      hit: DeclaredVar,
      name: string,
      span: SourceSpan,
      fromOutside: boolean,
    ): void => {
      if (hit.block.blockType === "VAR_TEMP") {
        if (fromOutside) {
          err(
            `'${name}' is a VAR_TEMP of '${hit.owner.name}': a temporary exists only during a call of the block and cannot be reached from outside (IEC 61131-3 6.5.2.1)`,
            span,
          );
        } else if (ctx.pou === "method" || ctx.pou === "property") {
          err(
            `'${name}' is a VAR_TEMP of the function block and is not available in a method (IEC 61131-3 6.6.7.2.3 rule 4)`,
            span,
          );
        } else if (caller !== hit.owner) {
          err(
            `'${name}' is a VAR_TEMP of base '${hit.owner.name}': it exists only during that block's own body (IEC 61131-3 6.5.2.1)`,
            span,
          );
        }
        return;
      }
      if (hit.decl.edge !== undefined && !fromOutside) {
        if (ctx.pou === "method" || ctx.pou === "property") {
          err(
            `'${name}' is a BOOL ${hit.decl.edge} input: a method has no access to an edge input (IEC 61131-3 6.6.7.2.3 rule 3)`,
            span,
          );
        } else if (caller !== hit.owner) {
          err(
            `'${name}' is a BOOL ${hit.decl.edge} input of base '${hit.owner.name}': its edge is detected in that block's body, so read it there (IEC 61131-3 6.6.3.2 item 13)`,
            span,
          );
        }
        return;
      }
      // A VAR section without an access specifier is PROTECTED (IEC 61131-3
      // 6.6.5.10; 6.6.7.2.6 for function blocks): only inputs and outputs
      // are reachable from outside the block.
      const access = hit.block.access ?? "PROTECTED";
      if (
        hit.block.blockType === "VAR" &&
        !allowed(caller, hit.owner, access)
      ) {
        err(
          `'${name}' is a ${access}${hit.block.access === undefined ? " (the default)" : ""} variable of '${hit.owner.name}' and cannot be accessed from ${caller ? `'${caller.name}'` : "here"} (IEC 61131-3 6.6.5.10)`,
          span,
        );
      }
    };

    const memberOf = (base: string): FunctionBlockDeclaration | undefined => {
      const upper = base.toUpperCase();
      if (upper === "THIS") return caller;
      if (upper === "SUPER") return family.get(caller?.extends);
      return family.get(ctx.types.get(upper));
    };

    for (const stmt of ctx.stmts) {
      walkAST(stmt, (n) => {
        if (n.kind === "VariableExpression") {
          const v = n as VariableExpression;
          const upper = v.name.toUpperCase();
          const field = v.fieldAccess[0];
          if (field !== undefined) {
            const target = memberOf(v.name);
            if (target) {
              const hit = family.findVar(target, field);
              const outside = upper !== "THIS" && upper !== "SUPER";
              if (hit)
                reportVar(hit, `${v.name}.${field}`, v.sourceSpan, outside);
            }
          }
          if (
            caller &&
            upper !== "THIS" &&
            upper !== "SUPER" &&
            !ctx.own.has(upper)
          ) {
            const hit = family.findVar(caller, v.name);
            if (hit) reportVar(hit, v.name, v.sourceSpan, false);
          }
          return undefined;
        }
        let objName: string | undefined;
        let methodName: string | undefined;
        if (n.kind === "FunctionCallExpression") {
          const fn = (n as FunctionCallExpression).functionName;
          const dot = fn.indexOf(".");
          if (dot > 0 && fn.indexOf(".", dot + 1) < 0) {
            objName = fn.substring(0, dot);
            methodName = fn.substring(dot + 1);
          }
        } else if (n.kind === "MethodCallExpression") {
          const mc = n as MethodCallExpression;
          if (
            mc.object.kind === "VariableExpression" &&
            mc.object.fieldAccess.length === 0
          ) {
            objName = mc.object.name;
            methodName = mc.methodName;
          }
        }
        if (objName === undefined || methodName === undefined) return undefined;
        const target = memberOf(objName);
        if (!target) return undefined;
        const found = family.findMethod(target, methodName);
        if (!found) return undefined;
        const { owner, method } = found;
        if (allowed(caller, owner, method.visibility)) return undefined;
        err(
          method.visibility === "PRIVATE"
            ? `Cannot call PRIVATE method '${methodName}' of '${owner.name.toUpperCase()}' from outside '${owner.name.toUpperCase()}'.`
            : `Cannot call PROTECTED method '${methodName}' of '${owner.name.toUpperCase()}' from '${caller ? caller.name.toUpperCase() : "PROGRAM"}'.`,
          n.sourceSpan,
        );
        return undefined;
      });
    }
  }
}
