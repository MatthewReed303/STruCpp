// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A structure whose field is an array of another structure declared later
 * in the source: the element type is emitted first, as for a plain field of
 * that type, so the generated C++ declares it before use.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `
TYPE
  S1 : STRUCT
    st : ARRAY[1..2] OF S2;
  END_STRUCT;
  S2 : STRUCT
    a : REAL;
  END_STRUCT;
END_TYPE

PROGRAM P
  VAR v : S1; r : REAL; END_VAR
  r := v.st[2].a;
END_PROGRAM

CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`;

describe("type order with an array field", () => {
  it("declares the element structure before the structure holding it", () => {
    const result = compile(SOURCE);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const s2 = result.headerCode.indexOf("struct S2 {");
    const s1 = result.headerCode.indexOf("struct S1 {");
    expect(s2).toBeGreaterThanOrEqual(0);
    expect(s1).toBeGreaterThan(s2);
  });
});
