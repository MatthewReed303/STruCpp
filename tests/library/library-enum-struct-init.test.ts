/**
 * A project STRUCT whose element defaults name a linked library's enumerated
 * values compiles.
 *
 * A bare enumerated value is of its enumeration (IEC 61131-3 6.4.4.2), so in
 * `motor : LibMotor := (set := (mode := LM_AUTO));` the C++ must name
 * `LibMode::LM_AUTO`: a typed enumeration is emitted inside a holder struct
 * (`LibMode__NAMED`), where the bare enumerator is not in scope. Variable
 * initialisers qualified it; STRUCT element defaults — nested structure
 * initializers and arrays of them — did not, because the type generator only
 * knew the enumerations of the types it was emitting, never a library's.
 * Compiling the library from source alongside the project hid the bug: its
 * enumerations were then the project's own.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "../integration/test-helpers.js";

const LIB = `
TYPE LibMode : USINT (LM_OFF, LM_HAND, LM_AUTO); END_TYPE
TYPE LibSrc : USINT (LS_NONE, LS_BOARD, LS_BUS); END_TYPE
TYPE LibSet : STRUCT mode : LibMode; END_STRUCT END_TYPE
TYPE LibMotor : STRUCT set : LibSet; END_STRUCT END_TYPE
TYPE LibDiSet : STRUCT src : LibSrc := LS_NONE; ch : USINT; END_STRUCT END_TYPE
`;

const lib = () => {
  const built = compileStlib([{ source: LIB, fileName: "types.st" }], {
    name: "enum-lib",
    version: "1.0.0",
    namespace: "elib",
  });
  expect(built.errors).toEqual([]);
  return loadStlibFromString(JSON.stringify(built.archive));
};

const PROGRAM = `
TYPE Dev : STRUCT
  motor : LibMotor := (set := (mode := LM_AUTO));
  din : ARRAY[1..3] OF LibDiSet := [(src := LS_BOARD, ch := 4), (src := LS_BUS), (ch := 7)];
END_STRUCT END_TYPE
PROGRAM Main
  VAR
    unit : Dev;
    motor : LibMotor := (set := (mode := LM_HAND));
    din : ARRAY[1..2] OF LibDiSet := [(src := LS_BUS, ch := 2), (src := LS_BOARD)];
  END_VAR
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("library enumerated values in STRUCT element defaults", () => {
  it("are qualified by their enumeration", () => {
    const result = compile(PROGRAM, {
      headerFileName: "generated.hpp",
      libraries: [lib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const code = result.headerCode + result.cppCode;
    expect(code).toContain("LIBMODE::LM_AUTO");
    expect(code).toContain("LIBSRC::LS_BOARD");
    expect(code).not.toMatch(/= LM_AUTO;/);
    expect(code).not.toMatch(/= LS_BOARD;/);
  });
});

(hasGpp ? describe : describe.skip)(
  "library enumerated values in STRUCT element defaults, compiled",
  () => {
    it("initialise nested structures and arrays of structures", () => {
      const result = compile(PROGRAM, {
        headerFileName: "generated.hpp",
        libraries: [lib()],
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "strucpp-lib-enum-init-"),
      );
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
  auto& d = p.UNIT;
  std::printf("%d %d %d %d %d %d %d | %d %d %d %d\\n",
              (int)d.MOTOR.SET.MODE.get(),
              (int)d.DIN[1].SRC.get(), (int)d.DIN[1].CH.get(),
              (int)d.DIN[2].SRC.get(), (int)d.DIN[2].CH.get(),
              (int)d.DIN[3].SRC.get(), (int)d.DIN[3].CH.get(),
              (int)p.MOTOR.SET.MODE.get(),
              (int)p.DIN[1].SRC.get(), (int)p.DIN[1].CH.get(),
              (int)p.DIN[2].SRC.get());
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
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
          "2 1 4 2 0 0 7 | 1 2 2 1",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
