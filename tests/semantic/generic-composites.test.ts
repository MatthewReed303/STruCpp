// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Composites on a generic parameter.
 *
 * A generic parameter takes an array, a structure or an enumeration as well as
 * an elementary type. The class numbers below were measured against a running
 * toolchain rather than read from a table.
 *
 * Every array is `TYPE_ARRAY` (26) whatever its elements — the class carries
 * no element type, no count and no rank. A structure is `TYPE_USERDEF` (28),
 * an enumeration `TYPE_ENUM` (25). `diSize` is the payload packed, so three
 * WORDs are 6 and `ARRAY[1..3]` reports the same as `ARRAY[0..2]`.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";

const TYPES = `TYPE ST : STRUCT a : WORD; b : DINT; END_STRUCT END_TYPE
TYPE EN : (RED, GREEN); END_TYPE
FUNCTION_BLOCK F VAR_INPUT P : ANY; END_VAR ; END_FUNCTION_BLOCK
`;

const build = (vars: string, arg: string, pin = "ANY") =>
  compile(
    TYPES.replace("P : ANY;", `P : ${pin};`) +
      `PROGRAM main VAR a : F; ${vars} END_VAR a(P := ${arg}); END_PROGRAM`,
    { programName: "main" },
  );

const emitted = (vars: string, arg: string) => {
  const result = build(vars, arg);
  const body = (result.cppCode ?? "").split("::run()")[1] ?? "";
  return body.split("\n").find((l) => l.includes("IEC_ANY")) ?? "";
};

describe("what a generic accepts", () => {
  it.each([
    ["an array of a bit type", "v : ARRAY[0..2] OF WORD;", "v"],
    ["an array of a bool", "v : ARRAY[0..2] OF BOOL;", "v"],
    ["an array of an integer", "v : ARRAY[0..2] OF DINT;", "v"],
    ["a two-dimensional array", "v : ARRAY[0..1,0..1] OF WORD;", "v"],
    ["an array with a non-zero base", "v : ARRAY[1..3] OF WORD;", "v"],
    ["a structure", "v : ST;", "v"],
    ["an enumeration", "v : EN;", "v"],
    ["an elementary type", "v : WORD;", "v"],
  ])("accepts %s", (_label, vars, arg) => {
    expect(build(vars, arg).errors).toEqual([]);
  });

  // "only a variable can be passed" — a generic is passed by reference, and
  // Stricter still elsewhere: some toolchains ask for write access, not an
  // address.
  it.each([
    ["a literal", "v : WORD;", "42"],
    ["an expression", "x : WORD; y : WORD;", "x + y"],
  ])("still refuses %s", (_label, vars, arg) => {
    expect(build(vars, arg).success).toBe(false);
  });
});

describe("the narrower families take arrays too", () => {
  // Both of these compile. The element decides which family an
  // array reaches, which is what keeps an ARRAY OF REAL off an ANY_INT pin.
  it("passes an array of DINT to ANY_INT", () => {
    expect(build("v : ARRAY[0..2] OF DINT;", "v", "ANY_INT").errors).toEqual(
      [],
    );
  });

  it("passes an array of WORD to ANY_BIT", () => {
    expect(build("v : ARRAY[0..2] OF WORD;", "v", "ANY_BIT").errors).toEqual(
      [],
    );
  });

  it("refuses an array of REAL on ANY_INT", () => {
    expect(build("v : ARRAY[0..2] OF REAL;", "v", "ANY_INT").success).toBe(
      false,
    );
  });
});

describe("the descriptor the call site builds", () => {
  it.each([
    ["an array", "v : ARRAY[0..2] OF WORD;", "v", "TYPE_ARRAY"],
    ["a structure", "v : ST;", "v", "TYPE_USERDEF"],
    ["an enumeration", "v : EN;", "v", "TYPE_ENUM"],
    ["an elementary type", "v : WORD;", "v", "TYPE_WORD"],
  ])("stamps %s as %s", (_label, vars, arg, cls) => {
    expect(emitted(vars, arg)).toContain(`TYPE_CLASS::${cls}`);
  });

  // The class is the same for every element type; only the size differs.
  it("gives an array of BOOL the same class as an array of WORD", () => {
    const words = emitted("v : ARRAY[0..2] OF WORD;", "v");
    const bools = emitted("v : ARRAY[0..2] OF BOOL;", "v");
    expect(words).toContain("TYPE_ARRAY");
    expect(bools).toContain("TYPE_ARRAY");
  });

  // diSize is the payload packed, while the stride is the
  // wrapper's width, which is what the memory actually steps by here.
  it("sizes an array by its payload and strides by its wrapper", () => {
    const line = emitted("v : ARRAY[0..2] OF WORD;", "v");
    expect(line).toContain("element_count() * sizeof(WORD_t)");
    expect(line).toContain("sizeof(IEC_WORD)");
  });

  it("addresses the first element, not the array object", () => {
    expect(emitted("v : ARRAY[1..3] OF WORD;", "v")).toContain(
      "elements()->raw_ptr()",
    );
  });

  it("counts every element of a two-dimensional array", () => {
    expect(emitted("v : ARRAY[0..1,0..1] OF WORD;", "v")).toContain(
      "element_count()",
    );
  });

  // A structure has no payload pointer of its own; it is addressed whole.
  it("addresses a structure whole", () => {
    expect(emitted("v : ST;", "v")).toMatch(/reinterpret_cast<uint8_t\*>\(&/);
  });
});
