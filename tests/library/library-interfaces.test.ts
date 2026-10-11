// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Interfaces across the library boundary (IEC 61131-3 Ed.3 6.6.6):
 *
 * - the manifest describes the library's interfaces (their method prototypes
 *   and EXTENDS, 6.6.6.6), what each block IMPLEMENTS, its PUBLIC methods
 *   (6.6.5.4.4; an OVERRIDE replacing the base's), its edge inputs (6.6.3.2
 *   item 13) and the C++ name of a pin the library renamed;
 * - a project declares a variable of a library interface, assigns it an
 *   instance of a library block implementing it — directly or through a base
 *   it EXTENDS (6.6.6.5.1) — passes an instance to an interface-typed input,
 *   and calls methods through both; an instance that does not implement the
 *   interface is refused.
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
INTERFACE LI_STATUS
  METHOD Code : INT
  END_METHOD
END_INTERFACE

INTERFACE LI_MOTOR EXTENDS LI_STATUS
  METHOD IsRunning : BOOL
  END_METHOD
  METHOD Request : BOOL
    VAR_INPUT On : BOOL; END_VAR
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK ABSTRACT LM_BASE
  VAR_INPUT Enable : BOOL; END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK LM_MOTOR IMPLEMENTS LI_MOTOR
  VAR_INPUT Start : BOOL R_EDGE; END_VAR
  VAR_OUTPUT Running : BOOL; END_VAR
  VAR PROTECTED want : BOOL; END_VAR
  METHOD PUBLIC Code : INT
    Code := 1;
  END_METHOD
  METHOD PUBLIC IsRunning : BOOL
    IsRunning := Running;
  END_METHOD
  METHOD PUBLIC Request : BOOL
    VAR_INPUT On : BOOL; END_VAR
    want := On;
    Request := TRUE;
  END_METHOD
  METHOD PRIVATE Hidden : BOOL
    Hidden := FALSE;
  END_METHOD
  IF Start THEN want := TRUE; END_IF;
  Running := want;
END_FUNCTION_BLOCK

FUNCTION_BLOCK LM_VSD EXTENDS LM_MOTOR
  VAR_INPUT Hz : REAL; END_VAR
  METHOD PUBLIC OVERRIDE Code : INT
    Code := 2;
  END_METHOD
  SUPER();
END_FUNCTION_BLOCK

FUNCTION_BLOCK LP_PUMP IMPLEMENTS LI_STATUS
  VAR_INPUT
    Motor : LI_MOTOR;
    Speed : REAL;
  END_VAR
  VAR_OUTPUT Code2 : INT; END_VAR
  VAR kept : REAL; END_VAR
  METHOD PUBLIC Code : INT
    Code := 3;
  END_METHOD
  METHOD PUBLIC SpeedNow : REAL
    SpeedNow := kept;
  END_METHOD
  kept := Speed;
  IF Motor <> NULL THEN
    Motor.Request(On := TRUE);
    Code2 := Motor.Code();
  END_IF;
END_FUNCTION_BLOCK

FUNCTION_BLOCK LP_PLAIN
  VAR_INPUT x : INT; END_VAR
END_FUNCTION_BLOCK
`;

const buildLib = (): StlibArchive => {
  const lib = compileStlib([{ source: LIB, fileName: "li.st" }], {
    name: "li-lib",
    version: "1.0.0",
    namespace: "li",
  });
  expect(lib.errors).toEqual([]);
  return loadStlibFromString(JSON.stringify(lib.archive));
};

const project = (body: string, vars = ""): string => `PROGRAM Main
  VAR
    m : LM_MOTOR;
    v : LM_VSD;
    p : LP_PUMP;
    i : LI_MOTOR;
    s : LI_STATUS;
    c1 : INT; c2 : INT; c3 : INT; r : BOOL; sp : REAL;
    ${vars}
  END_VAR
${body}
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const GOOD = project(`  p(Motor := v, Speed := 42.0);
  v(Hz := 50.0);
  i := m;
  s := p;
  c1 := i.Code();
  i := v;
  c2 := i.Code();
  c3 := s.Code();
  r := v.IsRunning() AND (i <> NULL);
  sp := p.Speed;`);

describe("library interfaces in the manifest", () => {
  it("lists the interfaces with their own prototypes and EXTENDS", () => {
    const m = buildLib().manifest;
    expect(
      (m.interfaces ?? []).map((i) => [
        i.name,
        i.extends ?? [],
        i.methods.map((x) => x.name),
      ]),
    ).toEqual([
      ["LI_STATUS", [], ["CODE"]],
      ["LI_MOTOR", ["LI_STATUS"], ["ISRUNNING", "REQUEST"]],
    ]);
    const request = m.interfaces![1]!.methods[1]!;
    expect(request.returnType).toBe("BOOL");
    expect(request.inputs.map((p) => [p.name, p.type])).toEqual([
      ["ON", "BOOL"],
    ]);
  });

  it("names what a block implements, its public methods and edge inputs", () => {
    const fbs = buildLib().manifest.functionBlocks;
    const motor = fbs.find((f) => f.name === "LM_MOTOR")!;
    expect(motor.implements).toEqual(["LI_MOTOR"]);
    expect((motor.methods ?? []).map((x) => x.name)).toEqual([
      "CODE",
      "ISRUNNING",
      "REQUEST",
    ]);
    expect(motor.inputs.find((p) => p.name === "START")?.edge).toBe("R_EDGE");
    const vsd = fbs.find((f) => f.name === "LM_VSD")!;
    expect(vsd.extends).toBe("LM_MOTOR");
    expect(vsd.implements).toBeUndefined();
    expect((vsd.methods ?? []).map((x) => x.name)).toEqual([
      "CODE",
      "ISRUNNING",
      "REQUEST",
    ]);
    expect(fbs.find((f) => f.name === "LM_BASE")?.isAbstract).toBe(true);
    // A pin cannot be named like a method of its block (IEC 61131-3
    // 6.6.5.5.5 rule 2), so none needs a C++ name of its own.
    const pump = fbs.find((f) => f.name === "LP_PUMP")!;
    expect(pump.inputs.find((p) => p.name === "SPEED")?.cppName).toBeUndefined();
    expect(pump.inputs.find((p) => p.name === "MOTOR")?.type).toBe("LI_MOTOR");
  });
});

describe("library interfaces in a project", () => {
  it("compiles instances assigned and passed to interface variables and pins", () => {
    const result = compile(GOOD, {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("P.MOTOR = V;");
    expect(result.cppCode).toContain("P.SPEED = 42.0;");
  });

  it("refuses an instance that does not implement the interface", () => {
    const result = compile(
      project("  p(Motor := q);\n  i := q;", "q : LP_PLAIN;"),
      { headerFileName: "generated.hpp", libraries: [buildLib()] },
    );
    const messages = result.errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/LP_PLAIN/);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a method the interface does not declare", () => {
    const result = compile(project("  r := i.Hidden();"), {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message).join("\n")).toMatch(
      /INTERFACE 'LI_MOTOR' has no method 'HIDDEN'/i,
    );
  });
});

(hasGpp ? describe : describe.skip)("library interfaces, run", () => {
  it("dispatches through the interface to the derived block's override", () => {
    const result = compile(GOOD, {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libiface-"));
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
  p.run();
  std::printf("%d|%d|%d|%d|%d|%g\\n", (int)p.C1, (int)p.C2, (int)p.C3,
              (int)p.P.CODE2, (int)p.R, (double)p.SP);
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
      // m answers 1, v (an LM_MOTOR by EXTENDS) its override 2, the pump 3;
      // the pump called v.Request(TRUE) and read v.Code() through its pin, so
      // v runs after its next call.
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
        "1|2|3|2|1|42",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a project block implementing a library interface", () => {
  const OWN = `FUNCTION_BLOCK OWN_STATUS IMPLEMENTS LI_STATUS
  METHOD PUBLIC Code : INT
    Code := 7;
  END_METHOD
END_FUNCTION_BLOCK
`;

  it("compiles, and the instance goes into a library interface variable (6.6.6.4)", () => {
    const result = compile(
      OWN + project("  s := o;\n  c1 := s.Code();", "o : OWN_STATUS;"),
      { headerFileName: "generated.hpp", libraries: [buildLib()] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  it("refuses IMPLEMENTS of a library block that is not an interface", () => {
    const result = compile(
      `FUNCTION_BLOCK NOT_IFACE IMPLEMENTS LM_MOTOR\nEND_FUNCTION_BLOCK\n` + project("  c1 := 0;"),
      { headerFileName: "generated.hpp", libraries: [buildLib()] },
    );
    expect(result.errors.map((e) => e.message).join("\n")).toMatch(/not an interface/);
  });
});
