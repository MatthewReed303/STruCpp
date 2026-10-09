/**
 * A linked library's enumerated values resolve as a project's own do.
 *
 * Each member of a library enumeration is a bare enumerated value of that type
 * (IEC 61131-3 6.4.4.2), so `SEL(g, LS_LOW, LS_FULL)` and `MOVE(LS_FULL)` are
 * of the enumeration. With the standard functions linked as a library (as the
 * CLI and the editor link them), a call whose generic inputs were all library
 * enumerators was typed ANY: "Cannot assign ANY to LIBSTOP".
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibFromFile } from "../../src/node/library-loader.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "../integration/test-helpers.js";

const STD = loadStlibFromFile(
  resolve(__dirname, "../../libs/iec-std-functions.stlib"),
);

const LIB = `
TYPE LibStop : (LS_NONE, LS_LOW, LS_FULL); END_TYPE
FUNCTION LIB_ID : LibStop
  VAR_INPUT s : LibStop; END_VAR
  LIB_ID := s;
END_FUNCTION
`;

const lib = () => {
  const built = compileStlib([{ source: LIB, fileName: "stop.st" }], {
    name: "stop-lib",
    version: "1.0.0",
    namespace: "stop",
  });
  expect(built.errors).toEqual([]);
  return loadStlibFromString(JSON.stringify(built.archive));
};

const PROGRAM = `
PROGRAM Main
  VAR x, y, z, w : LibStop; g : BOOL := TRUE; b : BOOL; END_VAR
  x := SEL(g, LS_LOW, LS_FULL);
  y := MOVE(LS_FULL);
  z := MUX(2, LS_NONE, LS_LOW, LS_FULL);
  w := LIB_ID(LS_LOW);
  b := EQ(x, LS_FULL);
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("library enumerated values", () => {
  it("are typed by their enumeration in generic standard functions", () => {
    const result = compile(PROGRAM, {
      headerFileName: "generated.hpp",
      libraries: [STD, lib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  it("give way to a project's own member of the same name", () => {
    const result = compile(
      `TYPE Mine : (LS_FULL, OTHER); END_TYPE
PROGRAM Main
  VAR m : Mine; END_VAR
  m := OTHER;
END_PROGRAM`,
      { headerFileName: "generated.hpp", libraries: [STD, lib()] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });
});

(hasGpp ? describe : describe.skip)(
  "library enumerated values, compiled",
  () => {
    it("select and move the values named", () => {
      const result = compile(PROGRAM, {
        headerFileName: "generated.hpp",
        libraries: [STD, lib()],
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-lib-enum-"));
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
  std::printf("%d %d %d %d %d\\n", (int)static_cast<strucpp::LIBSTOP>(p.X),
              (int)static_cast<strucpp::LIBSTOP>(p.Y), (int)static_cast<strucpp::LIBSTOP>(p.Z),
              (int)static_cast<strucpp::LIBSTOP>(p.W), (int)p.B);
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
        // SEL(TRUE, LOW, FULL) = FULL; MOVE(FULL); MUX(2, …) = FULL; LIB_ID(LOW).
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
          "2 2 2 1 1",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
