// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Two C++ spellings the compiler got wrong, each checked through g++:
 *
 * - An output renamed in C++ (`FLAG_`, an output named like its own type; an
 *   output named like a method of its block, the case first seen, is now
 *   refused by IEC 61131-3 6.6.5.5.5 rule 2). Read through an array ELEMENT,
 *   `va[1].Flag`, it named the unrenamed member; the plain instance
 *   `v1.Flag` was already right.
 * - An array literal of block instances given to an array of an interface
 *   type (IEC 61131-3 6.6.6.5.1: an instance implementing the interface is
 *   assignable to an element of it), as an input or by assignment, with NULL
 *   among them or not.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const SOURCE = `
TYPE Flag : STRUCT lit : BOOL; END_STRUCT; END_TYPE
INTERFACE IV
  METHOD IsOpen : BOOL
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK V IMPLEMENTS IV
  VAR_OUTPUT
    Flag : Flag;
  END_VAR
  METHOD PUBLIC IsOpen : BOOL
    IsOpen := TRUE;
  END_METHOD
  Flag.lit := TRUE;
END_FUNCTION_BLOCK
FUNCTION_BLOCK R
  VAR_INPUT
    Vs : ARRAY[1..2] OF IV;
  END_VAR
END_FUNCTION_BLOCK
PROGRAM P
  VAR
    va : ARRAY[1..2] OF V;
    v1 : V;
    v2 : V;
    r : R;
    b : BOOL;
    refs : ARRAY[1..3] OF IV;
  END_VAR
  b := va[1].Flag.lit;
  b := v1.Flag.lit;
  r(Vs := [v1, v2]);
  r(Vs := [va[1], va[2]]);
  refs := [v1, NULL, va[2]];
END_PROGRAM
CONFIGURATION C
  RESOURCE Res ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM i WITH t : P;
  END_RESOURCE
END_CONFIGURATION
`;

describe("an element's renamed member and interface array literals", () => {
  it("names the element's output, and each literal element as the interface", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("B = VA.at(1).FLAG_.LIT;");
    expect(result.cppCode).toContain("B = V1.FLAG_.LIT;");
    expect(result.cppCode).toContain("R_.VS = {IV(V1), IV(V2)};");
    expect(result.cppCode).toContain("R_.VS = {IV(VA.at(1)), IV(VA.at(2))};");
    expect(result.cppCode).toContain(
      "REFS = {IV(V1), IV(IEC_NULL), IV(VA.at(2))};",
    );
  });

  (hasGpp ? it : it.skip)("compiles with g++", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ifacearr-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      execSync(
        `g++ -std=${CXX_STD} -fsyntax-only -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" ` +
          `"${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
