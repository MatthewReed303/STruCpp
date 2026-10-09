// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Debug Table Generator
 *
 * Emits two artifacts alongside the normal compile() output:
 *
 *   1. `debugTableCpp` — contents for generated_debug.cpp, the per-project
 *      pointer tables consumed by strucpp::debug::handle_*() in the runtime
 *      header debug_dispatch.hpp.
 *
 *   2. `debugMap` — a JSON-serializable manifest the editor uses to translate
 *      variable paths (e.g. "INSTANCE0.speeds[5]") into the (arrayIdx,
 *      elemIdx) address pairs the target expects.
 *
 * Every leaf variable — including array elements, struct fields, and FB
 * input/output/inout members — gets its own entry. Leaves are packed into
 * arrays capped at 8,000 entries to stay below AVR GCC's 32,767-byte
 * single-object limit. A new array is also started at each program-instance
 * boundary so per-program edits don't cascade down the table.
 */

import type {
  ASTNode,
  CompilationUnit,
  FunctionCallExpression,
  VariableExpression,
  ProgramDeclaration,
  TypeReference,
  StructDefinition,
  EnumDefinition,
  SubrangeDefinition,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import { lockedGlobals, type ProjectModel } from "../project-model.js";
import type { SymbolTables } from "../semantic/symbol-table.js";
import { isElementaryType } from "../semantic/type-registry.js";
import {
  evalIntConst,
  isAnyDescriptorType,
  isVarInfoType,
  isDeclarableGenericType,
  MAX_TYPE_ALIAS_DEPTH,
} from "../semantic/type-utils.js";
import { formatArrayElementAccess } from "./codegen-utils.js";
import { mangledMemberName } from "./member-mangling.js";
import { GENERATED_TU_MACRO } from "./codegen.js";
import { walkAST } from "../ast-utils.js";

// ---------------------------------------------------------------------------
// Type tags — MUST match TypeTag enum in runtime/include/debug_dispatch.hpp.
// ---------------------------------------------------------------------------
export const TAG = {
  BOOL: 0,
  SINT: 1,
  USINT: 2,
  INT: 3,
  UINT: 4,
  DINT: 5,
  UDINT: 6,
  LINT: 7,
  ULINT: 8,
  REAL: 9,
  LREAL: 10,
  BYTE: 11,
  WORD: 12,
  DWORD: 13,
  LWORD: 14,
  TIME: 15,
  DATE: 16,
  TOD: 17,
  DT: 18,
  STRING: 19,
  WSTRING: 20,
} as const;

export type TagName = keyof typeof TAG;

// ---------------------------------------------------------------------------
// Per-leaf flag bits — MUST match LEAF_FLAG_* in
// runtime/include/debug_table.hpp. ABI: append only, never renumber.
//
// Carried down the leaf walk as an explicit parameter rather than a mutable
// `currentFlags`, because a bit can be *cleared* partway down a subtree —
// today nothing does, but the retain work adds exactly that (a NON_RETAIN
// member inside a RETAIN function-block instance), and a shared mutable
// would leak the cleared value into the following sibling.
// ---------------------------------------------------------------------------
export const LEAF_FLAG_READONLY = 1 << 0;

/** Mirrors LEAF_FLAG_RETAIN in runtime/include/debug_table.hpp. */
export const LEAF_FLAG_RETAIN = 1 << 1;
/**
 * Mirrors LEAF_FLAG_INDIRECT in runtime/include/debug_table.hpp: a leaf inside
 * a function block's VAR_IN_OUT — the caller's variable, reached through the
 * binding the call made (IEC 61131-3 §3.48). Always with READONLY.
 */
export const LEAF_FLAG_INDIRECT = 1 << 2;

/** How a reference kind reads in a "not debuggable" warning. */
const REFERENCE_KIND_TEXT: Record<string, string> = {
  pointer_to: "a POINTER TO",
  ref_to: "a REF_TO",
  reference_to: "a REFERENCE TO",
};

/** Why an array whose elements are pointers or references is left out. */
function arrayOfReferencesReason(kind: string): string {
  const text = (REFERENCE_KIND_TEXT[kind] ?? "a reference").replace(/^a /, "");
  return `an array of ${text} holds addresses, which the debugger cannot show or write.`;
}

/**
 * Apply one var block's qualifiers to the flags inherited from its container.
 *
 * RETAIN is inherited: declaring `VAR RETAIN inst : FB;` retains every leaf
 * inside `inst`, which is the CODESYS rule. NON_RETAIN is how a member opts
 * back out, so it CLEARS the bit rather than merely failing to set it — and
 * that is exactly why the walk passes flags down as a parameter instead of
 * mutating shared state: a cleared bit must not leak into the next sibling.
 */
function applyBlockFlags(
  inherited: number,
  block: { isConstant: boolean; isRetain: boolean; isNonRetain: boolean },
): number {
  let flags = inherited;
  if (block.isConstant) flags |= LEAF_FLAG_READONLY;
  if (block.isRetain) flags |= LEAF_FLAG_RETAIN;
  if (block.isNonRetain) flags &= ~LEAF_FLAG_RETAIN;
  return flags;
}

/**
 * Walk-only flag, never emitted: below it only retained leaves are kept. Set on
 * a library block's VAR member walked solely for the RETAIN state inside it.
 */
const WALK_RETAINED_ONLY = 1 << 7;

/**
 * Walk-only flag, never emitted: the leaf is an array element of a declared
 * type (an enumeration, alias or subrange), which C++ may store bare, without
 * a forcing wrapper. The emitted flags then ask the C++ type (LEAF_FLAG_RAW).
 */
const WALK_RAW_CANDIDATE = 1 << 6;

/**
 * Walk-only flag, never emitted: the walk is inside storage a TYPE declares
 * (a STRUCT's fields, a named ARRAY type's elements), which type-codegen.ts
 * emits, rather than a POU's own variables, which codegen.ts emits. The two
 * store an enumeration element differently: see `storedBare`.
 */
const WALK_IN_TYPE_DEF = 1 << 8;

/**
 * Walk-only flag, never emitted: `storedBare` expects the C++ element type of
 * this raw candidate to be bare, so the debug map marks the leaf `raw`. The
 * C++ table still takes LEAF_FLAG_RAW from the type itself (`leaf_raw_flag`);
 * this is only the editor's copy of that answer.
 */
const WALK_RAW_EXPECTED = 1 << 9;

/** The walk-only bits a STRUCT field or a block member never inherits. */
const WALK_RAW_BITS = WALK_RAW_CANDIDATE | WALK_RAW_EXPECTED;

/**
 * Mirrors `strucpp::retain::HEADER_SIZE` in runtime/include/iec_retain.hpp.
 * Changing one without the other makes the editor's capacity gate disagree
 * with the firmware's own arithmetic.
 */
const RETAIN_HEADER_SIZE = 14;

/**
 * FNV-1a (32-bit) over the retain layout — the ordered `path|typeTag` of every
 * retained leaf.
 *
 * Identity of the LAYOUT, deliberately not of the program: a body edit leaves
 * this unchanged and retained values survive, while adding, removing, retyping
 * or reordering a retained variable changes it and the stored blob is refused.
 * The project MD5 would have discarded retained state on every unrelated edit.
 *
 * FNV-1a rather than a cryptographic digest because this is a collision-check
 * against accident, not against an attacker, and it has to be computable in a
 * few lines on an AVR as well as here.
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Mirrors `strucpp::debug::RETAIN_NO_INDEX` (debug_table.hpp): the leaf is not
 * an element of an innermost array of scalars.
 */
const RETAIN_NO_INDEX = -0x80000000;

/**
 * A retained leaf's identity in a format-2 blob (`retain_leaves[]`).
 *
 * The name of the VARIABLE, because IEC 61131-3 6.5.6.1 rule 1 (p.57) keeps
 * "the values the variables had when the resource or configuration was
 * stopped": an upload that adds a member to a RETAIN struct must give every
 * other member its value back, and only a name can say which value is whose.
 * Paths are already canonical — upper case (6.1.2, p.24: identifiers are
 * case-insensitive), dotted, declared subscripts.
 *
 * An element of an innermost array of scalars hashes the array's path
 * (`CFG.SPARE[]`) and carries its subscript separately, so a resized array
 * keeps its elements by subscript and the blob describes the array as one run.
 *
 * `typeSig` (enumerated and subrange types) is folded into the hash: a changed
 * enumeration is a different variable, never a stored number re-read with a
 * different meaning.
 */
export function retainIdentityOf(
  path: string,
  typeSig?: string,
): { id: number; index: number } {
  const sig = typeSig ? `|${typeSig}` : "";
  const m = /^(.*)\[(-?\d+)\]$/.exec(path);
  if (m) {
    return { id: fnv1a32(`${m[1]}[]${sig}`), index: Number(m[2]) };
  }
  return { id: fnv1a32(`${path}${sig}`), index: RETAIN_NO_INDEX };
}

/** Format-2 payload width of a leaf: natural width, or 1 + declared length. */
function retainPayloadWidth(
  tagName: TagName,
  size: number,
  cap: number,
): number {
  const declared = cap >= 1 && cap <= 254 ? cap : 254;
  if (tagName === "STRING") return 1 + declared;
  if (tagName === "WSTRING") return 1 + 2 * declared;
  return size;
}

/**
 * Bytes of this program's format-2 blob: header, exact-width payload and the
 * descriptor trailer (iec_retain.hpp). Mirrors `strucpp::retain::blob_size2()`.
 * A string whose length this generator could not resolve (a symbolic
 * `STRING(N)`) is counted at the 254 maximum, so the figure is an upper bound
 * there and exact everywhere else.
 */
function retainBlobSize2Of(
  vars: Array<{
    path: string;
    tagName: TagName;
    size: number;
    cap: number;
    typeSig?: string;
  }>,
): number {
  let payload = 0;
  let trailer = 4;
  let open:
    | { id: number; tag: TagName; cap: number; next: number; count: number }
    | undefined;
  for (const v of vars) {
    payload += retainPayloadWidth(v.tagName, v.size, v.cap);
    const { id, index } = retainIdentityOf(v.path, v.typeSig);
    if (
      open !== undefined &&
      index !== RETAIN_NO_INDEX &&
      open.id === id &&
      open.tag === v.tagName &&
      open.cap === v.cap &&
      open.next === index &&
      open.count < 0xffff
    ) {
      open.next++;
      open.count++;
      continue;
    }
    if (index === RETAIN_NO_INDEX) {
      open = undefined;
      trailer += 6;
    } else {
      open = { id, tag: v.tagName, cap: v.cap, next: index + 1, count: 1 };
      trailer += 12;
    }
  }
  return RETAIN_HEADER_SIZE + payload + trailer;
}

/**
 * An enumerated type's definition, for the retained-leaf identity: its name and
 * its members in order with their values. Two enumerations that differ in any
 * of these are different data types, so a stored value of one is not a value
 * of the other (it was a member name, stored as its number).
 */
function enumSignature(name: string, def: EnumDefinition): string {
  const members = def.members.map((m) => {
    const value = m.value !== undefined ? evalIntConst(m.value) : undefined;
    return value !== undefined
      ? `${m.name.toUpperCase()}=${value}`
      : m.name.toUpperCase();
  });
  const base = def.baseType?.name?.toUpperCase() ?? "";
  return `ENUM ${name.toUpperCase()}:${base}(${members.join(",")})`;
}

/** A subrange type's definition (name, base, bounds), for the same reason. */
function subrangeSignature(name: string, def: SubrangeDefinition): string {
  const lo = evalIntConst(def.lowerBound);
  const hi = evalIntConst(def.upperBound);
  return `SUBRANGE ${name.toUpperCase()}:${def.baseType.name.toUpperCase()}(${lo ?? "?"}..${hi ?? "?"})`;
}

function retainLayoutHashOf(
  vars: Array<{ path: string; tagName: TagName }>,
): string {
  let hash = 0x811c9dc5;
  for (const v of vars) {
    for (const ch of `${v.path}|${v.tagName}`) {
      hash ^= ch.codePointAt(0) ?? 0;
      // >>> 0 after the multiply: JS bitwise ops are on int32, and FNV needs the
      // product truncated to 32 unsigned bits at every step.
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Render an entry's flags byte as C++.
 *
 * Emits the named constant rather than a literal so `generated_debug.cpp`
 * reads as intent — a reviewer scanning the table sees which leaves are
 * gated without decoding a bitmask — and so a stale generated file fails to
 * compile against a header that renamed the flag instead of silently setting
 * the wrong bit.
 */
function flagsLiteral(flags: number): string {
  const names: string[] = [];
  if (flags & LEAF_FLAG_READONLY) names.push("LEAF_FLAG_READONLY");
  if (flags & LEAF_FLAG_RETAIN) names.push("LEAF_FLAG_RETAIN");
  if (flags & LEAF_FLAG_INDIRECT) names.push("LEAF_FLAG_INDIRECT");
  return names.length > 0 ? names.join(" | ") : "0";
}

/**
 * An entry's flags byte: its LEAF_FLAG_* bits, plus LEAF_FLAG_RAW from the C++
 * type of an array element that may be stored bare (see `rawCandidate`).
 */
function entryFlags(e: Entry, indirectType?: string): string {
  const flags = flagsLiteral(e.flags);
  if (e.rawCandidate !== true) return flags;
  const type = indirectType ?? `decltype(${e.cppExpr})`;
  return `static_cast<uint8_t>(${flags} | leaf_raw_flag<${type}>::value)`;
}

/**
 * Render an entry's `cap` byte. A string leaf whose length was not known here
 * (a constant's name, an archive without lengths) takes it from its C++ type,
 * so the runtime never addresses it with the 254 default.
 */
function capLiteral(e: Entry, indirectType?: string): string {
  if (e.cap === 0 && (e.tagName === "STRING" || e.tagName === "WSTRING")) {
    return `string_cap<${indirectType ?? `decltype(${e.cppExpr})`}>::value`;
  }
  return String(e.cap);
}

/** Where a VAR_IN_OUT's leaves start: see `Entry.indirect`. */
interface IndirectRoot {
  binding: string;
  root: string;
  rootType: string;
  typeKey: string;
}

/**
 * One step of a leaf's access path below an in-out: a member, or an element
 * (one index, or two or three for a 2-D / 3-D array, as
 * `formatArrayElementAccess` writes them).
 */
type LeafStep = { field: string } | { index: string };

/** `.NAME`, `[i]` and `(i, j[, k])` steps of a leaf's C++ access path. */
function leafSteps(designator: string): LeafStep[] {
  const steps: LeafStep[] = [];
  const re =
    /\.([A-Za-z_][A-Za-z0-9_]*)|\[(-?\d+)\]|\((-?\d+(?:, -?\d+){1,2})\)/y;
  let at = 0;
  while (at < designator.length) {
    re.lastIndex = at;
    const m = re.exec(designator);
    if (!m) {
      throw new Error(
        `Internal error: in-out leaf path '${designator}' has a step the debug table cannot address`,
      );
    }
    steps.push(
      m[1] !== undefined ? { field: m[1] } : { index: (m[2] ?? m[3])! },
    );
    at = re.lastIndex;
  }
  return steps;
}

const TAG_NAME_BY_VALUE: Record<number, TagName> = Object.fromEntries(
  Object.entries(TAG).map(([k, v]) => [v, k as TagName]),
) as Record<number, TagName>;

/** Map IEC type name (upper case) → TagName (canonical). Handles aliases. */
const IEC_NAME_TO_TAG: Record<string, TagName> = {
  BOOL: "BOOL",
  SINT: "SINT",
  USINT: "USINT",
  INT: "INT",
  UINT: "UINT",
  DINT: "DINT",
  UDINT: "UDINT",
  LINT: "LINT",
  ULINT: "ULINT",
  REAL: "REAL",
  LREAL: "LREAL",
  BYTE: "BYTE",
  WORD: "WORD",
  DWORD: "DWORD",
  LWORD: "LWORD",
  // __XWORD is platform-width; the debug surface targets the native host
  // (where pointers are 64-bit), so it reads as an LWORD-tagged 8-byte value.
  __XWORD: "LWORD",
  TIME: "TIME",
  LTIME: "TIME",
  DATE: "DATE",
  // LDATE is deliberately absent: it wants nanoseconds where DATE_t holds
  // whole days, so tagging it as DATE would misreport every value by 86400e9.
  // Unsupported until it has its own representation.
  TOD: "TOD",
  TIME_OF_DAY: "TOD",
  LTOD: "TOD",
  DT: "DT",
  DATE_AND_TIME: "DT",
  LDT: "DT",
  STRING: "STRING",
  WSTRING: "WSTRING",
};

/** Byte size for each IEC elementary type — authoritative for debug. */
const IEC_NAME_TO_SIZE: Record<string, number> = {
  BOOL: 1,
  SINT: 1,
  USINT: 1,
  INT: 2,
  UINT: 2,
  DINT: 4,
  UDINT: 4,
  LINT: 8,
  ULINT: 8,
  REAL: 4,
  LREAL: 8,
  BYTE: 1,
  WORD: 2,
  DWORD: 4,
  LWORD: 8,
  __XWORD: 8,
  TIME: 8,
  LTIME: 8,
  DATE: 8,
  LDATE: 8,
  TOD: 8,
  TIME_OF_DAY: 8,
  LTOD: 8,
  DT: 8,
  DATE_AND_TIME: 8,
  LDT: 8,
  // STRING / WSTRING wire widths match `DEBUG_STRING_WIDTH` /
  // `DEBUG_WSTRING_WIDTH` in `runtime/include/debug_dispatch.hpp`.
  // The runtime always writes a full fixed-width window
  // (1 byte length + 126 bytes UTF-8 / 252 bytes UTF-16LE); the
  // editor decoder reads `min(length, 126)` from the prefix and
  // skips the remainder.  Pinning the same constants here keeps the
  // editor's batch-byte arithmetic aligned with what the runtime
  // actually sends per entry.
  STRING: 127,
  WSTRING: 253,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DebugLeaf {
  arrayIdx: number;
  elemIdx: number;
  /** Path from instance root, e.g. "INSTANCE0.SPEEDS[5]" or
   *  "INSTANCE0.FB_INST.COUNTER". */
  path: string;
  /** IEC type tag name (e.g. "INT", "BOOL", "REAL"). */
  type: string;
  /** Byte size of the leaf (matches type_ops[].size in the runtime). */
  size: number;
  /**
   * Present and `true` only for a leaf the debugger must not modify — an IEC
   * CONSTANT. Omitted otherwise, rather than written as `false`, because a
   * project's map holds thousands of leaves and the flag is rare.
   *
   * Advisory: it exists so the editor can hide the force control instead of
   * offering an action that will be refused. The refusal itself is enforced
   * in the runtime (`LEAF_FLAG_READONLY`), which is what makes an older
   * editor build — or an OPC-UA client that never reads this map — safe.
   *
   * Deliberately additive: `version` stays at 2 so an editor built against
   * the previous manifest keeps loading these maps unchanged. `debug-parser.ts`
   * rejects anything but 2 outright, so bumping it would break every editor
   * pinned to an older strucpp release.
   */
  readOnly?: true;
  /**
   * Present and `true` for a leaf declared `RETAIN` (or inherited from a
   * retained function-block instance). Omitted otherwise — a project's map
   * holds thousands of leaves and the flag is rare.
   */
  retain?: true;
  /**
   * Present and `true` for a leaf inside a function block's VAR_IN_OUT: a
   * live, read-only view of the CALLER's variable, followed through the
   * binding the last call made (IEC 61131-3 §3.48). Always `readOnly` too:
   * the variable is forced and written at its own name — see `target`.
   * Additive, like `readOnly`: an older editor shows it as a read-only leaf.
   */
  indirect?: true;
  /**
   * Present and `true` for a leaf C++ stores bare, without the forcing
   * wrapper every other leaf has: an element of a POU's own
   * `ARRAY OF <enumeration | alias | subrange>` (LEAF_FLAG_RAW in the table).
   * The debugger reads and writes it in place, but it cannot be forced: the
   * runtime refuses a force with STATUS_READ_ONLY, and releasing one is a
   * no-op. Not `readOnly`, because a write still succeeds.
   *
   * Advisory and additive, like `readOnly`: it lets the editor hide the force
   * control; the runtime enforces the refusal whatever the editor shows.
   */
  raw?: true;
  /**
   * For an `indirect` leaf, the path of the variable it shows, when every
   * call of the instance binds the in-out to the same plain variable (no
   * computed index). Absent when the binding cannot be named statically: the
   * variable is then whatever the last call passed.
   */
  target?: string;
}

export interface DebugMapV2 {
  version: 2;
  md5: string;
  typeTags: Record<string, number>;
  arrays: Array<{ index: number; count: number }>;
  leaves: DebugLeaf[];
  /**
   * The retained leaves, in the order the retain blob packs them. Additive, so
   * `version` stays at 2 — the editor's `debug-parser.ts` rejects anything else
   * outright, and an older editor simply ignores this field.
   */
  retainVars?: Array<{
    arrayIdx: number;
    elemIdx: number;
    path: string;
    size: number;
    /** Retain identity (FNV-1a32, hex) — `retain_leaves[].id`. */
    id?: string;
    /** Declared subscript, for an element of an innermost array of scalars. */
    index?: number;
  }>;
  /**
   * Total bytes the retain blob occupies: a 14-byte header plus one payload
   * slot per retained leaf. Matches `strucpp::retain::blob_size()`.
   *
   * Emitted so a build can be REFUSED when the target cannot hold it. Without
   * it the firmware links, runs, finds the blob too large for its buffer and
   * degrades to NON_RETAIN in silence.
   */
  retainBlobSize?: number;
  /** Retain blob format the program writes (iec_retain.hpp): 2. Absent = 1. */
  retainFormat?: number;
  /**
   * Identity of the retain LAYOUT, not of the program.
   *
   * FNV-1a over `path|typeTag` for each retained leaf in table order, so a body
   * edit keeps retained values while adding, removing, retyping or reordering a
   * retained variable invalidates them. Keying on the program MD5 instead would
   * discard retained state on every unrelated edit.
   */
  retainLayoutHash?: string;
}

export interface DebugTableResult {
  /** Contents for generated_debug.cpp (ready to write to disk). */
  debugTableCpp: string;
  /** Structured manifest for the editor (ready to JSON.stringify). */
  debugMap: DebugMapV2;
  /** Any leaves that couldn't be classified (unsupported type construct,
   *  user-defined enum, reference, etc.). Useful for warnings. */
  skipped: Array<{ path: string; reason: string }>;
  /**
   * Retained leaves whose identities collide (same 32-bit hash and subscript).
   * A build ERROR: a retained value restored by name must never be able to
   * land in a different variable. Renaming either variable resolves it.
   */
  retainErrors: Array<{ path: string; reason: string }>;
  /** Retained state the walk could not reach; surfaced as compile warnings. */
  incomplete: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DebugTableGenOptions {
  /** Max entries per debug array. Default 6000 — under AVR's 32767-byte
   *  per-object limit with sizeof(Entry) == 5 there (2-byte pointer, tag,
   *  flags, cap): 6000 * 5 = 30000. Each array is also static_assert'ed on
   *  AVR, so a bigger Entry fails the build with a clear message instead of
   *  "size of array is too large". */
  maxEntriesPerArray?: number;
  /** Name of the global configuration instance the generated table references.
   *  The sketch / runtime must declare this with external linkage. */
  configGlobalName?: string;
  /** MD5 to embed in the debug map. Caller computes over (program.st,
   *  strucpp version, projectModel) so the editor can detect staleness. */
  md5?: string;
}

const DEFAULTS: Required<Omit<DebugTableGenOptions, "md5">> = {
  maxEntriesPerArray: 6000,
  configGlobalName: "g_config",
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface Entry {
  /** For a LEAF_FLAG_INDIRECT leaf: the in-out's binding (`InOut::ref`), and
   *  the in-out's root as `cppExpr` starts with it (`root`), the C++ type of
   *  the in-out (`rootType`) and a key shared by in-outs of one type. */
  indirect?: IndirectRoot;
  cppExpr: string;
  tagName: TagName;
  path: string;
  type: TagName;
  size: number;
  /** Bitwise OR of LEAF_FLAG_*, emitted into the entry's `flags` byte. */
  flags: number;
  /** An array element C++ may store bare: LEAF_FLAG_RAW comes from its type. */
  rawCandidate?: true;

  /**
   * Declared capacity of a `STRING(n)` / `WSTRING(n)`; 0 for everything else and
   * for an unqualified string, which the runtime reads as the 254 default.
   */
  cap: number;
}

export function generateDebugTable(
  ast: CompilationUnit,
  projectModel: ProjectModel,
  symbolTables: SymbolTables,
  opts: DebugTableGenOptions = {},
): DebugTableResult {
  const maxEntries = opts.maxEntriesPerArray ?? DEFAULTS.maxEntriesPerArray;
  const configGlobal = opts.configGlobalName ?? DEFAULTS.configGlobalName;
  const md5 = opts.md5 ?? "";

  // Programs only live in the user AST (libraries don't ship PROGRAM blocks),
  // so we index them locally. Types and function blocks come from the symbol
  // table — that's the unified source covering both user-defined declarations
  // and library-loaded entries.
  const programByName = new Map<string, ProgramDeclaration>();
  for (const p of ast.programs) programByName.set(p.name.toUpperCase(), p);

  // --- Inputs to the shared member-mangling rule (see member-mangling.ts) ----
  // The table addresses members by the name codegen declared them under, so
  // both predicates have to resolve the same way codegen's do.

  const interfaceNames = new Set(
    ast.interfaces.map((i) => i.name.toUpperCase()),
  );

  /**
   * Mirrors `CodeGenerator.isUserDefinedType`: a function block, interface,
   * STRUCT/UDT, or program. Elementary types are excluded explicitly — codegen
   * leaves `Time : TIME` unmangled, so mangling it here would name a member
   * that does not exist.
   */
  const isUserDefinedType = (typeName: string): boolean => {
    const upper = typeName.toUpperCase();
    if (isElementaryType(upper)) return false;
    return (
      symbolTables.lookupType(upper) !== undefined ||
      symbolTables.lookupFunctionBlock(upper) !== undefined ||
      interfaceNames.has(upper) ||
      programByName.has(upper)
    );
  };

  const functionBlockTypeNames = new Set(
    ast.functionBlocks.map((fb) => fb.name.toUpperCase()),
  );
  const isFunctionBlockTypeName = (name: string): boolean =>
    functionBlockTypeNames.has(name.toUpperCase());

  /**
   * FB type name → upper-cased method names of every interface it implements,
   * mirroring `CodeGenerator.fbInterfaceMethodNames`. Directly implemented
   * interfaces only, which is what codegen consults.
   */
  const fbInterfaceMethods = new Map<string, Set<string>>();
  {
    const methodsByInterface = new Map<string, Set<string>>();
    for (const iface of ast.interfaces) {
      methodsByInterface.set(
        iface.name.toUpperCase(),
        new Set(iface.methods.map((m) => m.name.toUpperCase())),
      );
    }
    for (const fb of ast.functionBlocks) {
      if (!fb.implements || fb.implements.length === 0) continue;
      const methods = new Set<string>();
      for (const ifaceName of fb.implements) {
        for (const m of methodsByInterface.get(ifaceName.toUpperCase()) ?? []) {
          methods.add(m);
        }
      }
      if (methods.size > 0) {
        fbInterfaceMethods.set(fb.name.toUpperCase(), methods);
      }
    }
  }

  // Buckets of entries — grown in order, flushed at program boundary or size cap.
  const arrays: Entry[][] = [[]];
  const leaves: DebugLeaf[] = [];
  /** Retained leaves in walk order — the order the blob packs them. */
  const retainVars: Array<{
    arrayIdx: number;
    elemIdx: number;
    path: string;
    size: number;
    tagName: TagName;
    /** Declared STRING/WSTRING length when known here, else 0 (see capLiteral). */
    cap: number;
    /** The leaf's Entry, so retain_leaves[] can reuse its cap expression. */
    entry: Entry;
    /** Enumerated / subrange type definition, folded into the identity. */
    typeSig?: string;
  }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  // The value in-out being walked, if any: its leaves are INDIRECT. A stack,
  // because the walk is depth-first; an in-out's type holds no further in-out.
  const indirectStack: Array<IndirectRoot & { path: string; target?: string }> =
    [];
  let inoutRootCount = 0;
  const inoutTargets = computeInoutTargets(ast, projectModel, symbolTables);

  /**
   * Walk a function block's value VAR_IN_OUT `member` (an `InOut<V>`): its
   * leaves are the caller's variable, reached through the binding, so they are
   * INDIRECT and READONLY, and addressed by their offset inside the type. An
   * in-out is never retained — IEC 61131-3 §6.5.6: RETAIN "may be used for
   * variables declared in static VAR, VAR_INPUT, VAR_OUTPUT, and VAR_GLOBAL
   * sections but not in VAR_IN_OUT section" — so a RETAIN instance's in-out
   * is left out of the retain list, and said so.
   */
  const visitValueInout = (
    path: string,
    member: string,
    typeRef: TypeReference,
    flags: number,
  ) => {
    if (flags & LEAF_FLAG_RETAIN && !(flags & WALK_RETAINED_ONLY)) {
      incomplete.push({
        path,
        reason:
          `VAR_IN_OUT '${path}' is not retained: it is the caller's variable, ` +
          `retained (or not) where the caller declares it. IEC 61131-3 §6.5.6 ` +
          `allows RETAIN in VAR, VAR_INPUT, VAR_OUTPUT and VAR_GLOBAL, not in ` +
          `VAR_IN_OUT.`,
      });
    }
    if (flags & WALK_RETAINED_ONLY) return;
    const target = inoutTargets.get(path);
    // The leaves' paths below the in-out are written after `root`, a marker
    // rather than C++: the table addresses them by offset (renderCpp).
    const root = `@inout${inoutRootCount++}`;
    indirectStack.push({
      binding: `${member}.ref`,
      root,
      rootType: `std::remove_pointer<decltype(${member}.ref)>::type`,
      // In-outs of one named type share their leaves' offsets; an inline
      // ARRAY type is keyed by its own member.
      typeKey:
        typeRef.arrayDimensions === undefined
          ? `${typeRef.name.toUpperCase()}(${typeRef.maxLength ?? ""})`
          : root,
      path,
      ...(target !== undefined ? { target } : {}),
    });
    visitTypeRef(
      path,
      root,
      typeRef,
      (flags & ~LEAF_FLAG_RETAIN) | LEAF_FLAG_READONLY | LEAF_FLAG_INDIRECT,
    );
    indirectStack.pop();
  };

  /** A value in-out: not an FB instance (a pointer), not `ARRAY [*]` (a view). */
  const isValueInoutType = (typeRef: TypeReference): boolean =>
    !isFunctionBlockTypeName(typeRef.name) &&
    symbolTables.lookupFunctionBlock(typeRef.name) === undefined &&
    !typeRef.name.toUpperCase().startsWith("__VLA_");
  /**
   * Retained state the walk could not reach — today only a RETAIN on a library
   * block whose manifest predates exported locals.
   *
   * Kept apart from `skipped`, which is a normal list nobody reads on a good
   * build. These are surfaced as compile WARNINGS: the program still builds
   * and its visible surface is still retained, because refusing would strand
   * anyone using a third-party .stlib they cannot rebuild. But a partial
   * retain that nobody is told about is exactly the failure this reports.
   */
  const incomplete: Array<{ path: string; reason: string }> = [];

  const tail = (): Entry[] => arrays[arrays.length - 1]!;

  const ensureRoom = () => {
    if (tail().length >= maxEntries) arrays.push([]);
  };

  const addLeaf = (
    path: string,
    cppExpr: string,
    iecName: string,
    flags: number,
    maxLength?: number | string,
    typeSig?: string,
  ) => {
    if (flags & WALK_RETAINED_ONLY) {
      if (!(flags & LEAF_FLAG_RETAIN)) return;
      flags &= ~WALK_RETAINED_ONLY;
    }
    const rawCandidate = (flags & WALK_RAW_CANDIDATE) !== 0;
    const rawExpected = rawCandidate && (flags & WALK_RAW_EXPECTED) !== 0;
    flags &= ~(WALK_RAW_BITS | WALK_IN_TYPE_DEF);
    const tagName = IEC_NAME_TO_TAG[iecName.toUpperCase()];
    if (tagName === undefined) {
      skipped.push({ path, reason: `unknown elementary type: ${iecName}` });
      return;
    }
    const size = IEC_NAME_TO_SIZE[iecName.toUpperCase()] ?? 0;
    ensureRoom();
    const bucket = tail();
    const arrIdx = arrays.length - 1;
    const elemIdx = bucket.length;
    // A symbolic length (`STRING(BUF_MAX)`) is not resolved here: it records 0
    // and capLiteral takes the length from the member's C++ type.
    const cap =
      typeof maxLength === "number" && maxLength >= 1 && maxLength <= 254
        ? maxLength
        : 0;
    const ind = indirectStack[indirectStack.length - 1];
    const entry: Entry = {
      cppExpr,
      tagName,
      path,
      type: tagName,
      size,
      flags,
      cap,
      ...(ind !== undefined
        ? {
            indirect: {
              binding: ind.binding,
              root: ind.root,
              rootType: ind.rootType,
              typeKey: ind.typeKey,
            },
          }
        : {}),
      ...(rawCandidate ? { rawCandidate: true as const } : {}),
    };
    bucket.push(entry);
    leaves.push({
      arrayIdx: arrIdx,
      elemIdx,
      path,
      type: tagName,
      size,
      ...(flags & LEAF_FLAG_READONLY ? { readOnly: true as const } : {}),
      ...(flags & LEAF_FLAG_RETAIN ? { retain: true as const } : {}),
      ...(ind !== undefined ? { indirect: true as const } : {}),
      ...(rawExpected ? { raw: true as const } : {}),
      ...(ind?.target !== undefined
        ? { target: ind.target + path.slice(ind.path.length) }
        : {}),
    });
    if (flags & LEAF_FLAG_RETAIN) {
      retainVars.push({
        arrayIdx: arrIdx,
        elemIdx,
        path,
        size,
        tagName,
        cap,
        entry,
        ...(typeSig !== undefined ? { typeSig } : {}),
      });
    }
  };

  // The reference kind a TYPE alias resolves to (`TYPE PI : POINTER TO INT`), if any.
  const aliasReferenceKind = (typeName: string): string | undefined => {
    let name = typeName;
    for (let depth = 0; depth < MAX_TYPE_ALIAS_DEPTH; depth++) {
      const def = symbolTables.lookupType(name)?.declaration?.definition;
      if (def?.kind !== "TypeReference") return undefined;
      if (def.referenceKind !== undefined && def.referenceKind !== "none") {
        return def.referenceKind;
      }
      name = def.name;
    }
    return undefined;
  };

  /**
   * Whether C++ stores an array element of the ST type `typeName` bare — the
   * value itself, no forcing wrapper — which is what `leaf_raw_flag` finds in
   * the C++ type. The debug map's `raw` comes from here; the table's
   * LEAF_FLAG_RAW from the C++ type, so a slip here misleads only the editor.
   *
   * Mirrors the two emitters:
   *   - codegen.ts `mapTypeRefToCpp`: a POU's own ARRAY holds any declared
   *     TYPE by its own name, so an enumeration is the bare `enum class`;
   *   - type-codegen.ts `mapStructFieldTypeToCpp` (a named ARRAY type, a STRUCT
   *     field's ARRAY): an enumeration is the `IEC_<Name>` wrapper, anything
   *     else declared is its own name;
   * and in both an alias or a subrange is `using X = <base>`, which is bare
   * unless the base is a class (a STRING, a STRUCT, an ARRAY, a block).
   */
  const storedBare = (
    typeName: string,
    inTypeDef: boolean,
    viaAlias = false,
    depth = 0,
  ): boolean => {
    const upper = typeName.toUpperCase();
    if (IEC_NAME_TO_TAG[upper] !== undefined) {
      // Named directly, an elementary element is the IEC_<T> wrapper; behind
      // an alias it is the `<T>_t` value, a class only for the strings.
      return viaAlias && upper !== "STRING" && upper !== "WSTRING";
    }
    const def = symbolTables.lookupType(upper)?.declaration?.definition;
    if (def === undefined || depth > 32) return false;
    switch (def.kind) {
      case "EnumDefinition":
        // `using Alias = Color;` is the bare enum wherever it is used.
        return viaAlias || !inTypeDef;
      case "SubrangeDefinition":
        return true;
      case "TypeReference":
        if (
          def.name.toUpperCase() === upper ||
          def.arrayDimensions !== undefined ||
          (def.referenceKind !== undefined && def.referenceKind !== "none")
        ) {
          return false;
        }
        return storedBare(def.name, inTypeDef, true, depth + 1);
      default:
        return false;
    }
  };

  // visitTypeRef walks a TypeReference: elementary type → leaf, inline array
  // → per-element recursion, named user type (struct / FB / elementary alias)
  // → recurse into definition.
  const visitTypeRef = (
    path: string,
    cppExpr: string,
    typeRef: TypeReference,
    flags: number,
  ): void => {
    // Pointers are left out: the table has no per-leaf width and pointer size varies per target.
    // Checked before the array branch, since a POINTER TO ARRAY has dimensions too.
    if (
      typeRef.referenceKind !== undefined &&
      typeRef.referenceKind !== "none"
    ) {
      skipped.push({
        path,
        reason:
          `${REFERENCE_KIND_TEXT[typeRef.referenceKind] ?? "reference"} holds an ` +
          `address, which the debugger cannot show or write.`,
      });
      return;
    }

    // Inline array: `ARRAY[0..4] OF INT` → has arrayDimensions + elementTypeName
    if (typeRef.arrayDimensions && typeRef.elementTypeName) {
      const elementKind =
        typeRef.elementReferenceChain?.[0] ??
        aliasReferenceKind(typeRef.elementTypeName);
      if (elementKind !== undefined) {
        skipped.push({ path, reason: arrayOfReferencesReason(elementKind) });
        return;
      }
      walkArrayDims(
        path,
        cppExpr,
        typeRef.arrayDimensions,
        0,
        typeRef.elementTypeName,
        flags,
        [],
        typeRef.elementMaxLength,
      );
      return;
    }

    const name = typeRef.name.toUpperCase();

    // Named elementary type (or alias thereof).
    if (IEC_NAME_TO_TAG[name] !== undefined) {
      addLeaf(path, cppExpr, name, flags, typeRef.maxLength);
      return;
    }

    // A generic parameter and its descriptor are not values: `pvalue`
    // addresses a variable the debugger already lists, and `VAR_INFO` is the
    // same for a named one. Skipped by name rather than as an unsupported
    // kind, so the reason reads as a decision, not a hole in the walker.
    if (
      isDeclarableGenericType(name) ||
      isAnyDescriptorType(name) ||
      isVarInfoType(name)
    ) {
      skipped.push({
        path,
        reason: `${name} describes a variable rather than being one`,
      });

      return;
    }

    // Named type — covers user-defined TYPE..END_TYPE and library-registered
    // types (struct/enum/alias). The symbol table is the unified source.
    const ts = symbolTables.lookupType(name);
    if (ts) {
      // Built-in types are seeded without a declaration. Every one carrying a
      // value is matched by IEC_NAME_TO_TAG above, so there is nothing to walk.
      const def = ts.declaration?.definition;
      if (!def) {
        skipped.push({
          path,
          reason: `built-in type ${name} has no fields to watch`,
        });
        return;
      }
      if (def.kind === "StructDefinition") {
        visitStructFields(path, cppExpr, def, flags);
        return;
      }
      if (def.kind === "ArrayDefinition") {
        const ownKind = def.elementType.referenceKind;
        const elementKind =
          ownKind !== undefined && ownKind !== "none"
            ? ownKind
            : aliasReferenceKind(def.elementType.name);
        if (elementKind !== undefined) {
          skipped.push({ path, reason: arrayOfReferencesReason(elementKind) });
          return;
        }
        // TYPE MyArr: ARRAY[0..9] OF INT; END_TYPE
        const dims = def.dimensions
          .filter((d) => !d.isVariableLength)
          .map((d) => ({
            start: evalIntConst(d.start),
            end: evalIntConst(d.end),
          }));
        if (dims.some((d) => d.start === undefined || d.end === undefined)) {
          skipped.push({ path, reason: `array bounds not constant` });
          return;
        }
        walkArrayDims(
          path,
          cppExpr,
          dims as Array<{ start: number; end: number }>,
          0,
          def.elementType.name,
          // type-codegen.ts emits a named ARRAY type's element type.
          flags | WALK_IN_TYPE_DEF,
          [],
          def.elementType.maxLength,
        );
        return;
      }
      if (def.kind === "EnumDefinition") {
        // Enums are stored as their base type; treat as a scalar whose tag
        // matches the base. Default INT if no baseType.
        const baseName = def.baseType?.name?.toUpperCase() ?? "INT";
        if (IEC_NAME_TO_TAG[baseName] !== undefined) {
          addLeaf(
            path,
            cppExpr,
            baseName,
            flags,
            undefined,
            enumSignature(name, def),
          );
          return;
        }
        skipped.push({ path, reason: `enum base type ${baseName} unknown` });
        return;
      }
      if (def.kind === "SubrangeDefinition") {
        const baseName = def.baseType.name.toUpperCase();
        if (IEC_NAME_TO_TAG[baseName] !== undefined) {
          addLeaf(
            path,
            cppExpr,
            baseName,
            flags,
            undefined,
            subrangeSignature(name, def),
          );
          return;
        }
        skipped.push({ path, reason: `subrange base ${baseName} unknown` });
        return;
      }
      // TypeReference alias. The library loader registers library types
      // with `definition: TypeReference{ name: baseType ?? typeName }` —
      // an alias points at its base, but a struct with no baseType points
      // at itself (the manifest doesn't expose struct fields, so the
      // symbol carries only the type name). Treat self-referential
      // aliases as opaque library types: the debugger doesn't recurse
      // into them, just like it doesn't recurse into library FB locals.
      if (def.kind === "TypeReference") {
        if (def.name.toUpperCase() === name) {
          skipped.push({
            path,
            reason: `library type ${typeRef.name} is opaque to the debugger`,
          });
          return;
        }
        visitTypeRef(path, cppExpr, def, flags);
        return;
      }
      skipped.push({
        path,
        reason: `unsupported TYPE kind: ${(def as { kind: string }).kind}`,
      });
      return;
    }

    // Function block instance. The symbol table holds both user-defined
    // FBs (populated by the semantic analyzer from `ast.functionBlocks`)
    // and library FBs (populated by `registerLibrarySymbols` from the
    // .stlib manifest). The two paths intentionally surface different
    // amounts of state:
    //
    //   • Library FBs — only the public interface (inputs/outputs/inouts).
    //     Locals are implementation details that stay inside the
    //     compiled archive; the debugger treats library FBs as black
    //     boxes. The library loader leaves `locals` empty for this
    //     reason, so iterating the flat arrays gives just the
    //     interface.
    //
    //   • User-defined FBs — every persistent member, including VAR
    //     locals. The analyzer leaves the symbol's flat arrays empty
    //     and keeps the declarations in `declaration.varBlocks`, so we
    //     fall through to the AST walk and surface VAR alongside the
    //     interface blocks. VAR_TEMP / VAR_EXTERNAL are excluded —
    //     those are not persistent state.
    const fbSym = symbolTables.lookupFunctionBlock(name);
    // A block's members are never stored bare, and codegen.ts emits its class.
    if (fbSym) flags &= ~(WALK_RAW_BITS | WALK_IN_TYPE_DEF);
    if (fbSym) {
      const interfaceVars = [
        ...fbSym.inputs,
        ...fbSym.outputs,
        ...fbSym.inouts,
      ];
      // `name` is the FB type declaring these members, so it is the owner for
      // both mangling collisions.
      if (fbSym.libraryName !== undefined || interfaceVars.length > 0) {
        // Walked for nested RETAIN state only: the interface holds none.
        const retainedOnly =
          (flags & WALK_RETAINED_ONLY) !== 0 &&
          (flags & LEAF_FLAG_RETAIN) === 0;
        for (const v of retainedOnly ? [] : interfaceVars) {
          // A function block passed as an in-out is a pointer at someone
          // else's instance (as for a user block below): debugged at its own
          // name, never followed with `.member` through the pointer.
          if (
            v.isInOut &&
            (isFunctionBlockTypeName(v.declaration.type.name) ||
              symbolTables.lookupFunctionBlock(v.declaration.type.name) !==
                undefined)
          ) {
            skipped.push({
              path: `${path}.${v.name.toUpperCase()}`,
              reason:
                "function block in-out: an alias, debugged at its own name",
            });
            continue;
          }
          if (
            v.isInOut &&
            fbSym.inoutsByReference === true &&
            isValueInoutType(v.declaration.type)
          ) {
            visitValueInout(
              `${path}.${v.name.toUpperCase()}`,
              `${cppExpr}.${libraryMemberCppName(v, name)}`,
              v.declaration.type,
              flags,
            );
            continue;
          }
          visitTypeRef(
            `${path}.${v.name.toUpperCase()}`,
            `${cppExpr}.${libraryMemberCppName(v, name)}`,
            v.declaration.type,
            flags,
          );
        }

        // The block's own VAR members, from the manifest's `locals`.
        //
        // Only when the instance is RETAINed. The debugger keeps its
        // black-box view of a library block everywhere else — the
        // long-standing contract, and what stops a project instantiating a few
        // hundred OSCAT blocks from paying for internals nobody addresses.
        // Retain overrides it because a block restored from half its state
        // comes back in a configuration it could never have run into: a TON
        // with Q and ET but no STATE restarts its wait on the next scan.
        // Two reasons to descend into a library block's own VAR members:
        // the instance is RETAINed, or the library itself declared one of them
        // `VAR RETAIN` — which retains it in every instance, exactly as it
        // does for a user-defined block.
        const instanceRetained = (flags & LEAF_FLAG_RETAIN) !== 0;
        // A member that is not RETAIN itself is still walked when RETAIN
        // state is nested in it (a block holding a block), for that state only.
        const localsToWalk = instanceRetained
          ? fbSym.locals
          : fbSym.locals.filter(
              (v) => v.isRetain || holdsRetain(v.declaration.type),
            );
        if (localsToWalk.length > 0 || instanceRetained) {
          if (instanceRetained && fbSym.locals.length === 0) {
            // An archive whose manifest does not export locals. Retain still
            // covers the visible surface — refusing the build would strand
            // anyone using a third-party .stlib they cannot rebuild — but it
            // is a partial retain, so it is said out loud rather than left to
            // be discovered after a power cycle.
            incomplete.push({
              path,
              reason:
                `RETAIN on ${typeRef.name}: this library does not export the ` +
                `block's internal variables, so only its inputs and outputs ` +
                `are retained. Rebuild the library with a current STruC++ to ` +
                `retain the rest.`,
            });
          }
          for (const v of localsToWalk) {
            visitTypeRef(
              `${path}.${v.name.toUpperCase()}`,
              `${cppExpr}.${libraryMemberCppName(v, name)}`,
              v.declaration.type,
              v.isRetain
                ? flags | LEAF_FLAG_RETAIN
                : instanceRetained
                  ? flags
                  : flags | WALK_RETAINED_ONLY,
            );
          }
        }
      } else {
        // Walk the EXTENDS chain: an inherited member is a real member of
        // the instance. `owner` is the type that DECLARES each one —
        // `memberCppName` mangles against the owner's interface methods, so
        // the derived name would spell a base member wrong.
        const chain: Array<{ owner: string; blocks: VarBlock[] }> = [];
        const visited = new Set<string>();
        let cursor: typeof fbSym | undefined = fbSym;
        let cursorName = name;
        // Bounded by `visited`, so a cycle in EXTENDS ends the walk instead of
        // hanging the compiler.
        while (cursor && !visited.has(cursorName.toUpperCase())) {
          visited.add(cursorName.toUpperCase());
          chain.push({
            owner: cursorName,
            blocks: cursor.declaration.varBlocks,
          });
          const base = cursor.declaration.extends;
          if (!base) break;
          cursorName = base;
          cursor = symbolTables.lookupFunctionBlock(base);
        }

        // A derived declaration hides the base's, so claim derived-first and
        // emit base-first — the order C++ lays the members out in.
        const claimed = new Set<string>();
        const emit: Array<{
          owner: string;
          blocks: VarBlock[];
          take: Set<string>;
        }> = [];
        for (const entry of chain) {
          const take = new Set<string>();
          for (const block of entry.blocks) {
            if (
              block.blockType !== "VAR" &&
              block.blockType !== "VAR_INPUT" &&
              block.blockType !== "VAR_OUTPUT" &&
              block.blockType !== "VAR_IN_OUT"
            ) {
              continue;
            }
            for (const fieldDecl of block.declarations) {
              for (const fieldName of fieldDecl.names) {
                const key = fieldName.toUpperCase();
                if (claimed.has(key)) continue;
                claimed.add(key);
                take.add(key);
              }
            }
          }
          emit.push({ owner: entry.owner, blocks: entry.blocks, take });
        }

        for (const entry of emit.reverse()) {
          for (const block of entry.blocks) {
            if (
              block.blockType === "VAR" ||
              block.blockType === "VAR_INPUT" ||
              block.blockType === "VAR_OUTPUT" ||
              block.blockType === "VAR_IN_OUT"
            ) {
              // A `VAR CONSTANT` inside a function block is read-only for every
              // instance of it, and a `VAR RETAIN` member is retained in every
              // instance, so the block's own qualifiers are folded in here
              // rather than only at the program level.
              const memberFlags = applyBlockFlags(flags, block);
              for (const fieldDecl of block.declarations) {
                // A function block passed as an in-out is a pointer at someone
                // else's instance, which is in the table under its own name.
                // Following it would emit `.member` on a pointer, and it is
                // null until the caller binds it.
                if (
                  block.blockType === "VAR_IN_OUT" &&
                  isFunctionBlockTypeName(fieldDecl.type.name)
                ) {
                  for (const fieldName of fieldDecl.names) {
                    skipped.push({
                      path: `${path}.${fieldName.toUpperCase()}`,
                      reason:
                        "function block in-out: an alias, debugged at its own name",
                    });
                  }
                  continue;
                }
                const valueInout =
                  block.blockType === "VAR_IN_OUT" &&
                  isValueInoutType(fieldDecl.type);
                for (const fieldName of fieldDecl.names) {
                  if (!entry.take.has(fieldName.toUpperCase())) continue;
                  (valueInout ? visitValueInout : visitTypeRef)(
                    `${path}.${fieldName.toUpperCase()}`,
                    `${cppExpr}.${memberCppName(fieldName, fieldDecl.type, entry.owner)}`,
                    fieldDecl.type,
                    memberFlags,
                  );
                }
              }
            }
          }
        }
      }
      return;
    }

    skipped.push({ path, reason: `unresolved type name: ${typeRef.name}` });
  };

  /** UPPER(type name) → whether an instance of it holds RETAIN state. */
  const retainHolders = new Map<string, boolean>();

  /**
   * Whether a value of this type holds a member declared `VAR RETAIN` at any
   * depth: through function block members (library or project), STRUCT
   * fields and array elements.
   */
  const holdsRetain = (typeRef: TypeReference): boolean => {
    if (typeRef.referenceKind !== undefined && typeRef.referenceKind !== "none")
      return false;
    const name =
      typeRef.arrayDimensions && typeRef.elementTypeName
        ? typeRef.elementTypeName
        : typeRef.name;
    return typeHoldsRetain(name.toUpperCase());
  };

  const typeHoldsRetain = (name: string): boolean => {
    const known = retainHolders.get(name);
    if (known !== undefined) return known;
    // Provisional answer, so a recursive type ends the walk.
    retainHolders.set(name, false);
    let result = false;
    const def = symbolTables.lookupType(name)?.declaration?.definition;
    if (def?.kind === "StructDefinition") {
      result = def.fields.some((f) => holdsRetain(f.type));
    } else if (def?.kind === "ArrayDefinition") {
      result = holdsRetain(def.elementType);
    } else if (def?.kind === "TypeReference") {
      result = def.name.toUpperCase() !== name && holdsRetain(def);
    } else if (def === undefined) {
      const fb = symbolTables.lookupFunctionBlock(name);
      if (fb?.libraryName !== undefined) {
        result = fb.locals.some(
          (v) => v.isRetain || holdsRetain(v.declaration.type),
        );
      } else if (fb) {
        const base = fb.declaration.extends;
        result =
          fb.declaration.varBlocks.some(
            (b) =>
              (b.blockType === "VAR" ||
                b.blockType === "VAR_INPUT" ||
                b.blockType === "VAR_OUTPUT") &&
              !b.isNonRetain &&
              (b.isRetain
                ? b.declarations.length > 0
                : b.declarations.some((d) => holdsRetain(d.type))),
          ) ||
          (base !== undefined && typeHoldsRetain(base.toUpperCase()));
      }
    }
    retainHolders.set(name, result);
    return result;
  };

  const visitStructFields = (
    path: string,
    cppExpr: string,
    def: StructDefinition,
    flags: number,
  ): void => {
    // `flags` passes straight through: IEC puts CONSTANT on a var *block*, and
    // a STRUCT declares fields without blocks, so a struct field can never
    // introduce or clear the bit — it only inherits whatever the declaration
    // that named the struct carried. A field is never stored bare, and
    // type-codegen.ts emits the struct.
    flags = (flags & ~WALK_RAW_BITS) | WALK_IN_TYPE_DEF;
    for (const fieldDecl of def.fields) {
      for (const fieldName of fieldDecl.names) {
        visitTypeRef(
          `${path}.${fieldName.toUpperCase()}`,
          // No owner: a STRUCT implements no interfaces, so only the
          // field-name-matches-its-type collision can apply.
          `${cppExpr}.${memberCppName(fieldName, fieldDecl.type)}`,
          fieldDecl.type,
          flags,
        );
      }
    }
  };

  /**
   * Enumerate every element of an array, emitting one debug entry per element.
   *
   * Indices are collected across all dimensions and only turned into C++ at the
   * innermost level, because the accessor depends on the array's rank:
   * `Array2D`/`Array3D` take every index in one `operator()` call, so emitting a
   * subscript per dimension as we descend would produce `arr[i][j]` — which has
   * no matching operator on those containers and fails to compile.
   * {@link formatArrayElementAccess} owns that rank rule. The IEC display path
   * stays `[i][j]`, which is what the debug UI shows.
   */
  const walkArrayDims = (
    path: string,
    cppExpr: string,
    dims: Array<{ start: number; end: number }>,
    dimIdx: number,
    elementTypeName: string,
    flags: number,
    indices: number[] = [],
    elementMaxLength?: number | string,
  ): void => {
    if (dimIdx >= dims.length) {
      // Innermost element — visit as a TypeReference with the element type
      // name. Manufacture a minimal TypeReference for recursion.
      //
      // The element's declared length travels with it: every element of an
      // `ARRAY [0..3] OF STRING(23)` is an `IECStringVar<23>`.
      visitTypeRef(
        path,
        formatArrayElementAccess(cppExpr, indices),
        {
          kind: "TypeReference",
          name: elementTypeName,
          isReference: false,
          referenceKind: "none",
          ...(elementMaxLength !== undefined
            ? { maxLength: elementMaxLength }
            : {}),
        } as TypeReference,
        IEC_NAME_TO_TAG[elementTypeName.toUpperCase()] === undefined
          ? (flags & ~WALK_RAW_EXPECTED) |
              WALK_RAW_CANDIDATE |
              (storedBare(elementTypeName, (flags & WALK_IN_TYPE_DEF) !== 0)
                ? WALK_RAW_EXPECTED
                : 0)
          : flags & ~WALK_RAW_EXPECTED,
      );
      return;
    }
    const { start, end } = dims[dimIdx]!;
    for (let i = start; i <= end; i++) {
      walkArrayDims(
        `${path}[${i}]`,
        cppExpr,
        dims,
        dimIdx + 1,
        elementTypeName,
        flags,
        [...indices, i],
        elementMaxLength,
      );
    }
  };

  /**
   * C++ member name for a declaration, by the same rule codegen used to emit it
   * (see `member-mangling.ts`).
   *
   * The table addresses members by name, so it has to agree with the class
   * definition exactly, in *both* directions. Mangling too little named a member
   * that does not exist (`RunningLights : RunningLights` is declared
   * `RUNNINGLIGHTS_`); mangling too much would do the same in reverse, since
   * `Time : TIME` is declared plain `TIME`. Either way `generated_debug.cpp`
   * fails to compile and takes the whole firmware build with it — and nothing
   * catches it earlier, because `strucpp file.st` emits no debug table.
   *
   * `ownerTypeName` is the type declaring the member, needed for the
   * interface-method collision; undefined for a PROGRAM or a STRUCT, neither of
   * which can implement an interface.
   */
  /**
   * C++ member name for a member of a LIBRARY function block.
   *
   * Prefers the manifest's `cppName`, which the library recorded when its own
   * codegen mangled the member. Both mangling rules are decided against the
   * declaring unit — whether the member's type is user-defined THERE, and
   * which interface methods the block implements — and a consumer that
   * re-derives them can name a member the class does not declare, which fails
   * the build of generated_debug.cpp. Falling back to the shared rule covers
   * archives predating the field, where it is right in every case the bundled
   * libraries contain.
   */
  const libraryMemberCppName = (
    v: {
      name: string;
      declaration: VarDeclaration;
      cppName?: string | undefined;
    },
    ownerTypeName: string,
  ): string =>
    v.cppName ?? memberCppName(v.name, v.declaration.type, ownerTypeName);

  const memberCppName = (
    varName: string,
    typeRef: TypeReference | undefined,
    ownerTypeName?: string,
  ): string =>
    mangledMemberName(varName, typeRef?.name, {
      isUserDefinedType,
      interfaceMethods:
        ownerTypeName !== undefined
          ? fbInterfaceMethods.get(ownerTypeName.toUpperCase())
          : undefined,
    });

  const visitVarDecl = (
    path: string,
    cppExpr: string,
    decl: VarDeclaration,
    flags: number,
    ownerTypeName?: string,
  ): void => {
    for (const varName of decl.names) {
      visitTypeRef(
        `${path}.${varName.toUpperCase()}`,
        `${cppExpr}.${memberCppName(varName, decl.type, ownerTypeName)}`,
        decl.type,
        flags,
      );
    }
  };

  // Configurations carry both VAR_GLOBAL declarations and the
  // resource → task → program-instance tree. Globals go first so they own
  // a dedicated bucket at the head of the table — that way edits to a
  // program don't shift global addresses around.
  //
  // Path convention is bare uppercase name (no instance prefix): the
  // editor's `buildGlobalDebugPath()` returns `name.toUpperCase()` and
  // OPC-UA `GVL:foo` references resolve against the same key.
  // C++ expression is `${name}.value`: each global is a file-scope
  // `GlobalVar<V>` singleton (value + per-global mutex), declared `extern` in
  // the header and defined once in configuration.cpp, so `.value` reaches the
  // underlying IEC storage the debugger reads/writes directly — no
  // configuration-instance prefix — and `&name` is a link-time constant
  // (see codegen.ts emitFileScopeGlobals, iec_global.hpp).
  const seenGlobals = new Set<string>();
  // The index a runtime locks each global by, and the leaves each one holds.
  const lockIndex = new Map(
    lockedGlobals(projectModel).map((g, i) => [g.key, i]),
  );
  const globalLeaves: Array<{ start: number; end: number; g: number }> = [];
  const visitGlobal = (
    key: string,
    cppExpr: string,
    type: TypeReference,
    flags: number,
  ): void => {
    const start = leaves.length;
    visitTypeRef(key, cppExpr, type, flags);
    const g = lockIndex.get(key);
    if (g !== undefined && leaves.length > start) {
      globalLeaves.push({ start, end: leaves.length, g });
    }
  };
  for (const config of ast.configurations) {
    for (const block of config.varBlocks) {
      if (block.blockType !== "VAR_GLOBAL") continue;
      for (const decl of block.declarations) {
        for (const varName of decl.names) {
          // File-scope singletons are deduped by name; mirror that here so the
          // debug table doesn't emit duplicate entries for a shared global.
          const key = varName.toUpperCase();
          if (seenGlobals.has(key)) continue;
          seenGlobals.add(key);
          visitGlobal(
            key,
            `${varName}.value`,
            decl.type,
            applyBlockFlags(0, block),
          );
        }
      }
    }
  }

  // Walk configurations → resources → tasks → instances.
  for (const config of projectModel.configurations) {
    for (const resource of config.resources) {
      for (const task of resource.tasks) {
        for (const instance of task.programInstances) {
          // Program-instance boundary flush (unless current bucket is empty).
          if (tail().length > 0) arrays.push([]);

          const prog = programByName.get(instance.programType.toUpperCase());
          if (!prog) continue;

          const instName = instance.instanceName.toUpperCase();
          const basePath = instName;
          const baseCpp = `${configGlobal}.${instance.instanceName}`;

          for (const block of prog.varBlocks) {
            // Exclude VAR_EXTERNAL (points to globals handled separately) and
            // VAR_TEMP / VAR_IN_OUT (not persistent state). Debugger address
            // persistent local/input/output state.
            if (
              block.blockType !== "VAR" &&
              block.blockType !== "VAR_INPUT" &&
              block.blockType !== "VAR_OUTPUT"
            ) {
              continue;
            }
            const declFlags = applyBlockFlags(0, block);
            for (const decl of block.declarations) {
              visitVarDecl(basePath, baseCpp, decl, declFlags);
            }
          }
        }
      }
    }
  }

  // Drop trailing empty bucket if present.
  if (arrays.length > 0 && tail().length === 0) {
    arrays.pop();
  }
  // If everything is empty, keep one empty array for a valid table.
  if (arrays.length === 0) arrays.push([]);

  const configName = projectModel.configurations[0]?.name ?? "CONFIG0";
  const retainLayoutHash = retainLayoutHashOf(retainVars);
  // Identities of the retained leaves (retain format 2), and the guarantee the
  // restore relies on: no two retained leaves of one program share one.
  const retainIdentities = retainVars.map((v) =>
    retainIdentityOf(v.path, v.typeSig),
  );
  const retainErrors: Array<{ path: string; reason: string }> = [];
  {
    const seen = new Map<string, string>();
    retainVars.forEach((v, i) => {
      const { id, index } = retainIdentities[i]!;
      const key = `${id}:${index}`;
      const other = seen.get(key);
      if (other !== undefined) {
        retainErrors.push({
          path: v.path,
          reason:
            `retained variables '${other}' and '${v.path}' have the same retain ` +
            `identity (hash ${id.toString(16).padStart(8, "0")}): a restored value ` +
            `could reach the wrong one. Rename one of them.`,
        });
      } else {
        seen.set(key, v.path);
      }
    });
  }
  // Each global's leaves as runs within one array: {array, first, count, g}.
  const globalRuns: GlobalLeafRun[] = [];
  for (const { start, end, g } of globalLeaves) {
    for (let i = start; i < end; i++) {
      const leaf = leaves[i]!;
      const last = globalRuns[globalRuns.length - 1];
      if (
        i > start &&
        last !== undefined &&
        last.arr === leaf.arrayIdx &&
        last.first + last.count === leaf.elemIdx
      ) {
        last.count++;
      } else {
        globalRuns.push({
          arr: leaf.arrayIdx,
          first: leaf.elemIdx,
          count: 1,
          g,
          path: leaf.path,
        });
      }
    }
  }
  const debugTableCpp = renderCpp(
    arrays,
    configGlobal,
    configName,
    retainVars,
    retainIdentities,
    retainLayoutHash,
    globalRuns,
  );
  const debugMap: DebugMapV2 = {
    version: 2,
    md5,
    typeTags: { ...TAG },
    arrays: arrays.map((a, i) => ({ index: i, count: a.length })),
    leaves,
    // Omitted entirely when nothing is retained, so a project that uses no
    // RETAIN carries no retain fields at all and the runtime's `count == 0`
    // fast path is the only thing it ever sees.
    ...(retainVars.length > 0
      ? {
          retainVars: retainVars.map(
            ({ arrayIdx, elemIdx, path, size }, i) => ({
              arrayIdx,
              elemIdx,
              path,
              size,
              id: retainIdentities[i]!.id.toString(16).padStart(8, "0"),
              ...(retainIdentities[i]!.index !== RETAIN_NO_INDEX
                ? { index: retainIdentities[i]!.index }
                : {}),
            }),
          ),
          retainLayoutHash,
          // The format-2 blob (iec_retain.hpp): 14-byte header, exact-width
          // payload, descriptor trailer. Emitted so a build can be refused
          // when the target cannot hold the blob, and so a firmware sizes its
          // buffer from it.
          retainBlobSize: retainBlobSize2Of(retainVars),
          retainFormat: 2,
        }
      : {}),
  };

  return { debugTableCpp, debugMap, skipped, incomplete, retainErrors };
}

// ---------------------------------------------------------------------------
// In-out targets
// ---------------------------------------------------------------------------

/**
 * For each function-block instance in-out, the debug path of the variable its
 * calls bind it to — `"INST.PUMP.DATA" -> "INST.PUMPDATA"` — so the editor can
 * offer forcing at that variable (an in-out leaf is a read-only view of it).
 *
 * Only where it is one plain variable: every call of the instance in its POU
 * passes the same variable, named directly (fields and constant subscripts,
 * no computed index), and it is a local of that POU, a global, or the POU's
 * own in-out with a target of its own. Anything else has no target: the leaf
 * then shows whatever the last call passed.
 */
function computeInoutTargets(
  ast: CompilationUnit,
  projectModel: ProjectModel,
  symbolTables: SymbolTables,
): Map<string, string> {
  const targets = new Map<string, string>();
  const fbDecls = new Map(
    ast.functionBlocks.map((fb) => [fb.name.toUpperCase(), fb]),
  );
  const programs = new Map(ast.programs.map((p) => [p.name.toUpperCase(), p]));
  const globals = new Set<string>();
  for (const config of ast.configurations) {
    for (const block of config.varBlocks) {
      if (block.blockType !== "VAR_GLOBAL") continue;
      for (const d of block.declarations)
        for (const n of d.names) globals.add(n.toUpperCase());
    }
  }

  /** Declared parameter order and in-out names of an FB type. */
  const paramsOf = (
    type: string,
  ): { order: string[]; inouts: Set<string> } | undefined => {
    const decl = fbDecls.get(type.toUpperCase());
    if (decl) {
      const order: string[] = [];
      const inouts = new Set<string>();
      for (const b of decl.varBlocks) {
        if (
          b.blockType !== "VAR_INPUT" &&
          b.blockType !== "VAR_IN_OUT" &&
          b.blockType !== "VAR_OUTPUT"
        )
          continue;
        for (const d of b.declarations) {
          for (const n of d.names) {
            order.push(n.toUpperCase());
            if (b.blockType === "VAR_IN_OUT") inouts.add(n.toUpperCase());
          }
        }
      }
      return { order, inouts };
    }
    const sym = symbolTables.lookupFunctionBlock(type);
    if (!sym) return undefined;
    // Library blocks: named arguments only (the manifest keeps no order).
    return {
      order: [],
      inouts: new Set(sym.inouts.map((v) => v.name.toUpperCase())),
    };
  };

  /** `a.b[2].c` as a debug path suffix, or undefined if not plain. */
  const plainTail = (e: VariableExpression): string | undefined => {
    let tail = "";
    const steps = e.accessChain ?? [
      ...e.fieldAccess.map((name) => ({ kind: "field" as const, name })),
    ];
    for (const st of steps) {
      if (st.kind === "field") tail += `.${st.name.toUpperCase()}`;
      else if (st.kind === "subscript") {
        const idx: number[] = [];
        for (const ix of st.indices) {
          const v = evalIntConst(ix);
          if (v === undefined) return undefined;
          idx.push(v);
        }
        tail += `[${idx.join(",")}]`;
      } else return undefined;
    }
    return tail;
  };

  /**
   * Walk a POU instance at `path` (program or FB type `type`), resolving the
   * in-outs of the instances it calls. `ownInouts`: this POU's own in-outs, and
   * `externals`: its VAR_EXTERNAL names.
   */
  const walkPou = (
    path: string,
    varBlocks: VarBlock[],
    body: ASTNode[],
    depth: number,
  ): void => {
    if (depth > 32) return;
    const locals = new Map<string, string>(); // UPPER name -> type
    const ownInouts = new Set<string>();
    const externals = new Set<string>();
    for (const b of varBlocks) {
      for (const d of b.declarations) {
        for (const n of d.names) {
          const u = n.toUpperCase();
          if (b.blockType === "VAR_EXTERNAL") externals.add(u);
          else if (b.blockType === "VAR_IN_OUT") ownInouts.add(u);
          else locals.set(u, d.type.name);
        }
      }
    }
    // child instance -> in-out -> set of target paths (undefined = not plain)
    const bindings = new Map<string, Map<string, Set<string | undefined>>>();
    for (const stmt of body) {
      walkAST(stmt, (node) => {
        if (node.kind !== "FunctionCallExpression") return;
        const call = node as FunctionCallExpression;
        if (call.instance !== undefined) return;
        const inst = call.functionName.toUpperCase();
        const type = locals.get(inst);
        if (type === undefined) return;
        const params = paramsOf(type);
        if (!params || params.inouts.size === 0) return;
        let next = 0;
        const named = new Set(
          call.arguments
            .filter((a) => a.name !== undefined)
            .map((a) => a.name!.toUpperCase()),
        );
        for (const arg of call.arguments) {
          let slot = arg.name?.toUpperCase();
          if (slot === undefined) {
            while (next < params.order.length && named.has(params.order[next]!))
              next++;
            slot = params.order[next++];
          }
          if (slot === undefined || arg.isOutput || !params.inouts.has(slot))
            continue;
          let target: string | undefined;
          const v = arg.value;
          if (v.kind === "VariableExpression" && !v.isDereference) {
            const tail = plainTail(v);
            const root = v.name.toUpperCase();
            if (tail !== undefined) {
              if (externals.has(root) && globals.has(root))
                target = root + tail;
              else if (ownInouts.has(root)) {
                const t = targets.get(`${path}.${root}`);
                target = t !== undefined ? t + tail : undefined;
              } else if (locals.has(root)) target = `${path}.${root}${tail}`;
            }
          }
          let byInout = bindings.get(inst);
          if (!byInout)
            bindings.set(
              inst,
              (byInout = new Map<string, Set<string | undefined>>()),
            );
          let set = byInout.get(slot);
          if (!set) byInout.set(slot, (set = new Set<string | undefined>()));
          set.add(target);
        }
      });
    }
    for (const [inst, byInout] of bindings) {
      for (const [slot, set] of byInout) {
        if (set.size === 1) {
          const only = [...set][0];
          if (only !== undefined) targets.set(`${path}.${inst}.${slot}`, only);
        }
      }
    }
    // Descend into user FB instances declared here (scalar instances only).
    for (const [name, type] of locals) {
      const decl = fbDecls.get(type.toUpperCase());
      if (!decl) continue;
      walkPou(`${path}.${name}`, decl.varBlocks, decl.body, depth + 1);
    }
  };

  for (const config of projectModel.configurations) {
    for (const resource of config.resources) {
      for (const task of resource.tasks) {
        for (const instance of task.programInstances) {
          const prog = programs.get(instance.programType.toUpperCase());
          if (!prog) continue;
          walkPou(
            instance.instanceName.toUpperCase(),
            prog.varBlocks,
            prog.body,
            0,
          );
        }
      }
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// C++ rendering
// ---------------------------------------------------------------------------

/** Consecutive debug leaves of one locked global, within one array. */
interface GlobalLeafRun {
  arr: number;
  first: number;
  count: number;
  g: number;
  /** The first leaf's path, for the comment. */
  path: string;
}

function renderCpp(
  arrays: Entry[][],
  configGlobal: string,
  configName: string,
  retainVars: Array<{
    arrayIdx: number;
    elemIdx: number;
    path: string;
    tagName: TagName;
    entry: Entry;
  }>,
  retainIdentities: Array<{ id: number; index: number }>,
  retainLayoutHash: string,
  globalRuns: GlobalLeafRun[],
): string {
  const lines: string[] = [];
  lines.push("// SPDX-License-Identifier: GPL-3.0-or-later");
  lines.push("// Generated by STruC++ debug-table-gen - Do not edit by hand.");
  lines.push("//");
  lines.push("// Per-project debugger pointer tables consumed by");
  lines.push("// strucpp::debug::handle_*() in debug_dispatch.hpp.");
  lines.push("");
  lines.push(`#define ${GENERATED_TU_MACRO}`);
  lines.push('#include "generated.hpp"');
  // `debug_table.hpp` carries the AVR-clean subset (Entry, TypeTag,
  // STRUCPP_DEBUG_FLASH).  Including `debug_dispatch.hpp` here would
  // pull `<avr/pgmspace.h>` → `<avr/io.h>` into the only TU that
  // names user variables — AVR register macros (`SP`, `SREG`, …)
  // would then mangle identifiers like PID's `SP` setpoint.  See
  // runtime/include/debug_table.hpp.
  lines.push('#include "debug_table.hpp"');
  lines.push("");
  lines.push(
    `// The sketch/runtime must define this global with external linkage:`,
  );
  lines.push(`//   strucpp::Configuration_${configName} ${configGlobal};`);
  lines.push(`// The debug table below reaches into it via compile-time`);
  lines.push(`// address-of expressions — so it must be a real object, not a`);
  lines.push(`// static-local or a pointer.`);
  lines.push(`extern ::strucpp::Configuration_${configName} ${configGlobal};`);
  lines.push("");
  lines.push("namespace strucpp { namespace debug {");
  lines.push("");

  // VAR_IN_OUT leaves: where each one's binding is and the leaf's offset in
  // the in-out's type (see IndirectRef in debug_table.hpp). The offsets are
  // `offsetof` chains, one constant per distinct leaf of each in-out type, so
  // no object of the type is needed. Before the entry arrays, which take the
  // IndirectRefs' addresses.
  const indirectIndex = new Map<Entry, number>();
  const indirectType = new Map<Entry, string>();
  const indirectLines: string[] = [];
  const offsetLines: string[] = [];
  const offsetNodes = new Map<string, { type: string; offset: string }>();
  const offsetNode = (
    ind: IndirectRoot,
    steps: LeafStep[],
  ): { type: string; offset: string } => {
    const key = `${ind.typeKey}\u0000${JSON.stringify(steps)}`;
    const known = offsetNodes.get(key);
    if (known) return known;
    const n = offsetNodes.size;
    let node: { type: string; offset: string };
    if (steps.length === 0) {
      node = { type: `__dioT${n}`, offset: `__dio${n}` };
      offsetLines.push(`using ${node.type} = ${ind.rootType};`);
      offsetLines.push(`constexpr uintptr_t ${node.offset} = 0;`);
    } else {
      const parent = offsetNode(ind, steps.slice(0, -1));
      const step = steps[steps.length - 1]!;
      const m = offsetNodes.size;
      node = { type: `__dioT${m}`, offset: `__dio${m}` };
      if ("field" in step) {
        offsetLines.push(
          `using ${node.type} = decltype(${parent.type}::${step.field});`,
        );
        offsetLines.push(
          `constexpr uintptr_t ${node.offset} = ${parent.offset} + offsetof(${parent.type}, ${step.field});`,
        );
      } else {
        offsetLines.push(`using ${node.type} = ${parent.type}::element_type;`);
        offsetLines.push(
          `constexpr uintptr_t ${node.offset} = ${parent.offset} + ${parent.type}::element_offset(${step.index});`,
        );
      }
    }
    offsetNodes.set(key, node);
    return node;
  };
  for (const bucket of arrays) {
    for (const e of bucket) {
      if (e.indirect === undefined) continue;
      const node = offsetNode(
        e.indirect,
        leafSteps(e.cppExpr.slice(e.indirect.root.length)),
      );
      indirectIndex.set(e, indirectLines.length);
      indirectType.set(e, node.type);
      indirectLines.push(
        `    { (const void*)&${e.indirect.binding}, ${node.offset} },  // ${e.path}`,
      );
    }
  }
  if (indirectLines.length > 0) {
    // A STRUCT with an EXTENDS base is not standard-layout; `offsetof` of its
    // members is still exact for a non-virtual base, which is all there is.
    lines.push("#if defined(__GNUC__)");
    lines.push("#pragma GCC diagnostic push");
    lines.push('#pragma GCC diagnostic ignored "-Winvalid-offsetof"');
    lines.push("#endif");
    for (const line of offsetLines) lines.push(line);
    lines.push("#if defined(__GNUC__)");
    lines.push("#pragma GCC diagnostic pop");
    lines.push("#endif");
    lines.push("");
    lines.push(
      `const IndirectRef debug_indirect[${indirectLines.length}] STRUCPP_DEBUG_FLASH = {`,
    );
    // One at a time: a spread of a large program's table overflows the stack.
    for (const line of indirectLines) lines.push(line);
    lines.push("};");
    lines.push("");
  }

  for (let ai = 0; ai < arrays.length; ai++) {
    const bucket = arrays[ai]!;
    lines.push(
      `const Entry debug_arr_${ai}[${bucket.length || 1}] STRUCPP_DEBUG_FLASH = {`,
    );
    if (bucket.length === 0) {
      lines.push(`    { nullptr, 0, 0 },  // placeholder — array is empty`);
    } else {
      for (const e of bucket) {
        lines.push(
          // The `(void*)` cast is load-bearing AND lossy: a CONSTANT member is
          // declared `const`, and a C-style cast strips that silently where
          // `static_cast` would refuse. The flags byte is what carries the
          // qualifier through to the runtime so the write paths can honour it.
          indirectIndex.has(e)
            ? `    { (void*)&debug_indirect[${indirectIndex.get(e)}], TAG_${e.tagName}, ${entryFlags(e, indirectType.get(e))}, ${capLiteral(e, indirectType.get(e))} },  // ${e.path} (in-out)`
            : `    { (void*)&${e.cppExpr}, TAG_${e.tagName}, ${entryFlags(e)}, ${capLiteral(e)} },  // ${e.path}`,
        );
      }
    }
    lines.push("};");
    lines.push("#ifdef __AVR__");
    lines.push(
      `static_assert(sizeof(debug_arr_${ai}) <= 32767, "debug_arr_${ai} is over AVR's 32767-byte object limit: lower maxEntriesPerArray");`,
    );
    lines.push("#endif");
    lines.push("");
  }

  const arrNames = arrays.map((_, i) => `debug_arr_${i}`);
  lines.push(
    `const Entry* const debug_arrays[${arrays.length}] STRUCPP_DEBUG_FLASH = {`,
  );
  for (const n of arrNames) lines.push(`    ${n},`);
  lines.push("};");
  lines.push("");

  lines.push(
    `const uint16_t debug_array_counts[${arrays.length}] STRUCPP_DEBUG_FLASH = {`,
  );
  for (const b of arrays) lines.push(`    ${b.length},`);
  lines.push("};");
  lines.push("");

  lines.push(`const uint8_t debug_array_count = ${arrays.length};`);
  lines.push("");

  // --- Retain table --------------------------------------------------------
  //
  // Retained leaves addressed the same way the debugger addresses everything
  // else: (arr, elem) into the tables above. No offsets, no sizeof — the host
  // reads and writes each leaf through `handle_read` / `handle_write`, so it
  // moves the VALUE and never the IECVar wrapper's forcing state, and a nested
  // function-block member or a configuration global needs no special case.
  //
  // Order is the walk order, and it IS the blob's packing order.
  lines.push("// Retained leaves, in the order the retain blob packs them.");
  lines.push(
    `const RetainVar retain_vars[${retainVars.length || 1}] STRUCPP_DEBUG_FLASH = {`,
  );
  if (retainVars.length === 0) {
    lines.push("    { 0, 0 },  // placeholder — nothing is retained");
  } else {
    for (const v of retainVars) {
      lines.push(`    { ${v.arrayIdx}, ${v.elemIdx} },  // ${v.path}`);
    }
  }
  lines.push("};");
  lines.push("");
  lines.push(`const uint16_t retain_var_count = ${retainVars.length};`);
  lines.push("");
  lines.push(
    "// Identity of the retain LAYOUT (ordered path|typeTag), not of the",
  );
  lines.push(
    "// program: a body edit keeps retained values, a declaration change",
  );
  lines.push("// invalidates them.");
  lines.push(`const uint32_t retain_layout_hash = 0x${retainLayoutHash};`);
  lines.push("");
  // Format-2 identities, parallel to retain_vars[] (debug_table.hpp).
  lines.push(
    "// Each retained leaf's identity: FNV-1a32 of its canonical path, subscript,",
  );
  lines.push(
    "// type and declared length. A changed program takes back every stored value",
  );
  lines.push(
    "// whose variable still exists, by name (iec_retain.hpp, format 2).",
  );
  lines.push(
    `const RetainLeaf retain_leaves[${retainVars.length || 1}] STRUCPP_DEBUG_FLASH = {`,
  );
  if (retainVars.length === 0) {
    lines.push(
      "    { 0, RETAIN_NO_INDEX, 0, 0 },  // placeholder — nothing is retained",
    );
  } else {
    retainVars.forEach((v, i) => {
      const { id, index } = retainIdentities[i]!;
      const idx = index === RETAIN_NO_INDEX ? "RETAIN_NO_INDEX" : String(index);
      lines.push(
        `    { 0x${id.toString(16).padStart(8, "0")}u, ${idx}, TAG_${v.tagName}, ${capLiteral(v.entry)} },  // ${v.path}`,
      );
    });
  }
  lines.push("};");
  lines.push("");

  // --- Leaf -> global ------------------------------------------------------
  //
  // The index (see the configuration's strucpp_global_lock) of the global a
  // leaf is in, so a runtime reads or writes it under that global's lock.
  lines.push("#ifdef STRUCPP_THREADED");
  lines.push("// The leaves each locked global holds, as runs in one array.");
  if (globalRuns.length > 0) {
    lines.push(
      `static const GlobalLeafRun global_leaf_runs[${globalRuns.length}] = {`,
    );
    for (const r of globalRuns) {
      lines.push(
        `    { ${r.arr}, ${r.first}, ${r.count}, ${r.g} },  // ${r.path}`,
      );
    }
    lines.push("};");
  }
  lines.push("");
  lines.push(
    "// The global a debug leaf is in, or -1 when it is in none that is locked.",
  );
  lines.push(
    'extern "C" int32_t strucpp_debug_global_index(uint8_t arr, uint16_t elem) {',
  );
  lines.push(
    globalRuns.length > 0
      ? `    return global_of_leaf(global_leaf_runs, ${globalRuns.length}, arr, elem);`
      : "    return global_of_leaf(nullptr, 0, arr, elem);",
  );
  lines.push("}");
  lines.push("#endif  // STRUCPP_THREADED");
  lines.push("");
  lines.push("} } // namespace strucpp::debug");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Expression helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers exposed for tests
// ---------------------------------------------------------------------------

export function tagNameForTypeName(name: string): TagName | undefined {
  return IEC_NAME_TO_TAG[name.toUpperCase()];
}

export function sizeForTypeName(name: string): number {
  return IEC_NAME_TO_SIZE[name.toUpperCase()] ?? 0;
}

/** For debugging / testing: reverse lookup tag → name. */
export function tagNameByValue(tag: number): TagName | undefined {
  return TAG_NAME_BY_VALUE[tag];
}
