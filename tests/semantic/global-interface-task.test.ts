// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A global function block instance assigned to an interface (IEC 61131-3
 * 6.6.6.5.1: an interface variable refers to an instance; nothing limits it to
 * local ones). In a threaded runtime every global sits behind its own lock and
 * a reference bypasses it, so the reference is allowed when no other thread
 * can reach the instance: every program that uses it, and a global block that
 * receives it, run in one task. The reference is to the global's own storage,
 * never to a copy.
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

const POUS = `
INTERFACE I_V
  METHOD Read : REAL
  END_METHOD
  METHOD Bump : BOOL
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK SRC IMPLEMENTS I_V
  VAR_INPUT x : REAL; END_VAR
  METHOD PUBLIC Read : REAL
    Read := x;
  END_METHOD
  METHOD PUBLIC Bump : BOOL
    x := x + 1.0;
    Bump := TRUE;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK USE
  VAR_INPUT s : I_V; END_VAR
  VAR_OUTPUT y : REAL; END_VAR
  VAR ok : BOOL; END_VAR
  IF s <> NULL THEN
    ok := s.Bump();
    y := s.Read();
  END_IF;
END_FUNCTION_BLOCK
PROGRAM A
  VAR_EXTERNAL g : SRC; END_VAR
  g();
END_PROGRAM
PROGRAM B
  VAR_EXTERNAL g : SRC; u : USE; END_VAR
  u(s := g);
END_PROGRAM
`;

const config = (taskA: string, taskB: string): string => `
CONFIGURATION C
  VAR_GLOBAL g : SRC; u : USE; END_VAR
  RESOURCE R ON PLC
    TASK t1(INTERVAL := T#10ms, PRIORITY := 0);
    TASK t2(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM ia WITH ${taskA} : A;
    PROGRAM ib WITH ${taskB} : B;
  END_RESOURCE
END_CONFIGURATION`;

const messages = (src: string): string[] =>
  compile(src, { headerFileName: "generated.hpp" }).errors.map((e) => e.message);

describe("a global instance assigned to an interface", () => {
  it("is allowed when one task uses it, and refers to the global's storage", () => {
    const result = compile(POUS + config("t1", "t1"), {
      headerFileName: "generated.hpp",
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("__fbi.S = G->value;");
  });

  it("is refused when programs in two tasks use it", () => {
    expect(messages(POUS + config("t1", "t2")).join("\n")).toMatch(
      /used by more than one task cannot be assigned to interface I_V/,
    );
  });

  it("is refused when a function block also uses it (any task)", () => {
    const fb = `
FUNCTION_BLOCK PEEK
  VAR_EXTERNAL g : SRC; END_VAR
  VAR_OUTPUT v : REAL; END_VAR
  v := g.x;
END_FUNCTION_BLOCK
`;
    expect(messages(fb + POUS + config("t1", "t1")).join("\n")).toMatch(
      /used by more than one task/,
    );
  });

  (hasGpp ? it : it.skip)(
    "changes the global itself through the reference, not a copy",
    () => {
      const result = compile(POUS + config("t1", "t1"), {
        headerFileName: "generated.hpp",
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gref-"));
      try {
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
        fs.writeFileSync(
          path.join(dir, "main.cpp"),
          `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_C g_config;
int main() {
  for (int i = 0; i < 3; i++) { g_config.IA.run(); g_config.IB.run(); }
  std::printf("%g|%g\\n", (double)strucpp::G.value.X, (double)strucpp::U.value.Y);
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
        // three Bump() calls through the reference reach g itself
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("3|3");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
