// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A formal method call (IEC 61131-3 6.6.1.4.2, which methods follow): named
 * arguments take their parameter's place whatever order they are written in,
 * and an omitted input takes its declared initial value.
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
} from "../integration/test-helpers.js";

const SRC = `
FUNCTION_BLOCK P
  VAR_OUTPUT got : DINT; END_VAR
  METHOD PUBLIC Request : BOOL
    VAR_INPUT
      A : DINT;
      B : DINT := 20;
      Urgent : BOOL;
    END_VAR
    got := A * 100 + B + SEL(Urgent, 0, 5);
    Request := TRUE;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
  VAR p : P; ok : BOOL; r1 : DINT; r2 : DINT; END_VAR
  ok := p.Request(A := 1);
  r1 := p.got;
  ok := p.Request(Urgent := TRUE, B := 3, A := 2);
  r2 := p.got;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("formal method calls", () => {
  it("compiles a call that omits an input", () => {
    const result = compile(SRC, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  (hasGpp ? it : it.skip)(
    "passes the declared default and places named arguments by name",
    () => {
      const result = compile(SRC, { headerFileName: "generated.hpp" });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mdef-"));
      try {
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
        fs.writeFileSync(
          path.join(dir, "main.cpp"),
          `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  auto& m = g_config.INSTANCE0;
  m.run();
  std::printf("%d|%d\\n", (int)m.R1, (int)m.R2);
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
        // A := 1, B default 20, Urgent default FALSE -> 120; A 2, B 3, Urgent -> 208
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("120|208");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
