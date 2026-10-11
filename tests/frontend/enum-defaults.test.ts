// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Defaults of enumerated types and data types with named values (IEC 61131-3
 * Ed.3 6.4.4.2.2, 6.4.4.3.2): the type's own initial value, else the first
 * element of the list — for scalars, array elements (inline arrays and array
 * TYPEs) and a library's types used by a consumer. The library manifest keeps
 * the explicit values (6.4.4.3) and the type's initial value.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";

const TYPES = `
TYPE
  NV : USINT (NV_A := 5, NV_B := 7);
  NVD : USINT (NVD_C := 3, NVD_D := 9) := NVD_D;
  EN : (EN_UP, EN_DOWN) := EN_DOWN;
  PLAIN : (P_ONE, P_TWO);
  ROW : ARRAY[1..2] OF NV;
END_TYPE`;

const initList = (cpp: string): string =>
  cpp.split("\n").find((l) => l.trimStart().startsWith(": ")) ?? "";

describe("enumeration defaults (IEC 61131-3 6.4.4.2.2, 6.4.4.3.2)", () => {
  const build = (vars: string): string => {
    const result = compile(`${TYPES}
PROGRAM Main
VAR ${vars} END_VAR
END_PROGRAM`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return initList(result.cppCode);
  };

  it("starts a named-value variable at its first element", () => {
    expect(build("n : NV;")).toContain("N(NV::NV_A)");
  });

  it("keeps the type's own initial value and the declaration's", () => {
    const inits = build("d : NVD; given : NV := NV_B;");
    expect(inits).toContain("D(NVD::NVD_D)");
    expect(inits).toContain("GIVEN(NV::NV_B)");
  });

  it("leaves an enumeration without explicit values at its zero first element", () => {
    expect(build("p : PLAIN; x : INT;")).not.toContain("P(");
  });

  it("fills an inline array with the element type's default", () => {
    const inits = build(
      "na : ARRAY[1..3] OF NV; da : ARRAY[1..2, 1..2] OF NVD; ea : ARRAY[0..1] OF EN;",
    );
    expect(inits).toContain("NA({NV::NV_A, NV::NV_A, NV::NV_A})");
    expect(inits).toContain(
      "DA({NVD::NVD_D, NVD::NVD_D, NVD::NVD_D, NVD::NVD_D})",
    );
    expect(inits).toContain("EA({EN::EN_DOWN, EN::EN_DOWN})");
  });

  it("fills an array TYPE with the element type's default", () => {
    expect(build("r : ROW;")).toContain("R({NV::NV_A, NV::NV_A})");
  });
});

describe("a library's enumerations", () => {
  const lib = () => {
    const result = compileStlib(
      [
        {
          source: `${TYPES}
FUNCTION_BLOCK HOLD
  VAR_OUTPUT o : NV; END_VAR
END_FUNCTION_BLOCK`,
          fileName: "t.st",
        },
      ],
      { name: "enum-lib", version: "1.0.0", namespace: "el" },
    );
    expect(result.errors).toEqual([]);
    return result.archive;
  };

  it("keeps the explicit values and the type's initial value in the manifest", () => {
    const types = lib().manifest.types;
    const nv = types.find((t) => t.name === "NV")!;
    expect(nv.members).toEqual(["NV_A", "NV_B"]);
    expect(nv.values).toEqual(["5", "7"]);
    expect(nv.defaultValue).toBeUndefined();
    const nvd = types.find((t) => t.name === "NVD")!;
    expect(nvd.values).toEqual(["3", "9"]);
    expect(nvd.defaultValue).toBe("NVD_D");
    const en = types.find((t) => t.name === "EN")!;
    expect(en.values).toBeUndefined();
    expect(en.defaultValue).toBe("EN_DOWN");
  });

  it("starts a consumer's variables of the library's types at their defaults", () => {
    const archive = loadStlibFromString(JSON.stringify(lib()));
    const result = compile(
      `PROGRAM Main
VAR n : NV; d : NVD; e : EN; p : PLAIN; na : ARRAY[1..2] OF NV; END_VAR
END_PROGRAM`,
      { libraries: [archive] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const inits = initList(result.cppCode);
    expect(inits).toContain("N(NV::NV_A)");
    expect(inits).toContain("D(NVD::NVD_D)");
    expect(inits).toContain("E(EN::EN_DOWN)");
    expect(inits).toContain("NA({NV::NV_A, NV::NV_A})");
    expect(inits).not.toContain("P(");
  });
});
