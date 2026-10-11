// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Across the library boundary:
 *
 * - a library block EXTENDS another block of the same library; its manifest
 *   entry lists the inherited variables (IEC 61131-3 6.6.5.5.2 rule 2) and a
 *   project instantiates and calls it with its base's inputs;
 * - a library FUNCTION with a VAR_OUTPUT called formally from a project: the
 *   arguments map by name in any order, an omitted input takes its declared
 *   initial value (6.6.1.4.2), and the output is written back (6.6.2.2).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "../integration/test-helpers.js";

const LIB = `
FUNCTION_BLOCK LB_BASE
  VAR_INPUT a : INT; Go : BOOL R_EDGE; END_VAR
  VAR_OUTPUT x : INT; edges : INT; END_VAR
  VAR n : INT; END_VAR
  VAR_TEMP t : INT; END_VAR
  METHOD PUBLIC Kind : INT
    Kind := 1;
  END_METHOD
  t := a + 1;
  x := t;
  n := n + 1;
  IF Go THEN edges := edges + 1; END_IF;
END_FUNCTION_BLOCK

FUNCTION_BLOCK LB_DERIVED EXTENDS LB_BASE
  VAR_INPUT b : INT; END_VAR
  METHOD PUBLIC OVERRIDE Kind : INT
    Kind := 2;
  END_METHOD
  SUPER();
  x := 3 * x + b;
END_FUNCTION_BLOCK

FUNCTION LB_SCALE : REAL
  VAR_INPUT
    In : REAL;
    InMin : REAL := 0.0;
    InMax : REAL := 100.0;
    OutMin : REAL := 0.0;
    OutMax : REAL := 10.0;
  END_VAR
  VAR_OUTPUT SpanBad : BOOL; END_VAR
  SpanBad := InMax = InMin;
  IF SpanBad THEN
    LB_SCALE := OutMin;
  ELSE
    LB_SCALE := OutMin + (In - InMin) * (OutMax - OutMin) / (InMax - InMin);
  END_IF;
END_FUNCTION
`;

const buildLib = (): StlibArchive => {
  const lib = compileStlib([{ source: LIB, fileName: "lb.st" }], {
    name: "lb-lib",
    version: "1.0.0",
    namespace: "lb",
  });
  expect(lib.errors).toEqual([]);
  return loadStlibFromString(JSON.stringify(lib.archive));
};

const PROJECT = `PROGRAM Main
  VAR
    d : LB_DERIVED;
    k : INT;
    r1 : REAL; r2 : REAL;
    bad1 : BOOL; bad2 : BOOL := TRUE;
  END_VAR
  d(a := 1, b := 2, Go := TRUE);
  d(a := 1, b := 2, Go := TRUE);
  k := d.Kind();
  r1 := LB_SCALE(SpanBad => bad1, InMax := 50.0, In := 25.0);
  r2 := LB_SCALE(In := 5.0, InMin := 1.0, InMax := 1.0, SpanBad => bad2);
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("library block inheritance in the manifest", () => {
  it("lists the inherited variables, base first, and names the base", () => {
    const fb = buildLib().manifest.functionBlocks.find(
      (f) => f.name === "LB_DERIVED",
    )!;
    expect(fb.extends).toBe("LB_BASE");
    expect(fb.inputs.map((i) => i.name)).toEqual(["A", "GO", "B"]);
    expect(fb.outputs.map((o) => o.name)).toEqual(["X", "EDGES"]);
    // The VAR members of the base too (retain); no VAR_TEMP.
    expect((fb.locals ?? []).map((l) => l.name)).toEqual(["N"]);
  });

  it("compiles a project calling the derived block with its base's inputs", () => {
    const result = compile(PROJECT, {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });
});

(hasGpp ? describe : describe.skip)("library inheritance and outputs, run", () => {
  it("runs the derived body with SUPER(), the edge, and the function outputs", () => {
    const result = compile(PROJECT, {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libinh-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "main.cpp"),
        `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  std::printf("%d|%d|%d|%g|%d|%g|%d\\n", (int)p.D.X, (int)p.D.EDGES, (int)p.K,
              (double)p.R1, (int)p.BAD1, (double)p.R2, (int)p.BAD2);
  return 0;
}
`,
      );
      const bin = path.join(dir, "run");
      execSync(
        `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      // x = 3 * (a + 1) + b = 8; one rising edge over two calls; Kind
      // overridden; 25 of 0..50 -> 5 of 0..10; a zero span flags SpanBad.
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
        "8|1|2|5|0|0|1",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
