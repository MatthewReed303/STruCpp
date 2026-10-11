// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A method returning a user type (an enumeration, with or without a base
 * type) yields that type: its result compares with the type's own values
 * (IEC 61131-3 Table 38), called on an instance, an array element or an
 * element of an `ARRAY [*]` in-out.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const source = (expr: string): string => `
TYPE
  E : USINT (EA, EB) := EA;
  F : (FA, FB) := FA;
END_TYPE

FUNCTION_BLOCK X
  METHOD PUBLIC R1 : E
    R1 := EB;
  END_METHOD
  METHOD PUBLIC R2 : F
    R2 := FB;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Y
  VAR_IN_OUT xs : ARRAY[*] OF X; END_VAR
  VAR b : BOOL; e : E; END_VAR
  b := xs[1].R1() = EB;
  b := xs[1].R2() <> FA;
  e := xs[1].R1();
END_FUNCTION_BLOCK

PROGRAM P
  VAR x : X; xa : ARRAY[1..2] OF X; b : BOOL; END_VAR
  b := x.R1() = EB;
  b := xa[1].R1() = EB;
  b := ${expr};
END_PROGRAM

CONFIGURATION C
  RESOURCE R ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`;

describe("a method's user-typed result", () => {
  it("compares with its own type's values", () => {
    const result = compile(source("x.R2() = FB"));
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  it("refuses a value of another enumeration", () => {
    const result = compile(source("x.R2() = EB"));
    expect(result.errors.map((e) => e.message)).toEqual([
      "Cannot compare F = E: an enumerated value compares only with a value of its own type (IEC 61131-3 Table 38)",
    ]);
  });
});
