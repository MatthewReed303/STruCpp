// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A library block whose parameter is an `ARRAY [*] OF <library type>` depends
 * on that type.
 *
 * The AST names an `ARRAY [*] OF T` only `__VLA_<rank>D_T` (it has no
 * `elementTypeName`), and both dependency walks read just `name` and
 * `elementTypeName`. The block's chunk therefore never listed T, so a project
 * that used the block without naming T itself got the block's class and not
 * T: "'UIO_XMOD' was not declared" (node-uio UIO_EXPANSION, modbee-mqtt
 * SPARKPLUG_DAY_TOTALS).
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
TYPE XKIND : (XK_NONE, XK_DI, XK_DO); END_TYPE
TYPE XMOD : STRUCT kind : XKIND; addr : INT; END_STRUCT; END_TYPE
TYPE XGRID : (XG_OFF, XG_ON); END_TYPE
FUNCTION_BLOCK XHELP
  VAR_INPUT x : INT; END_VAR
  VAR_OUTPUT y : INT; END_VAR
  y := x + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK XEXPANSION
  VAR_IN_OUT
    MODULES : ARRAY[*] OF XMOD;
    GRID : ARRAY[*, *] OF XGRID;
    HELPERS : ARRAY[*] OF XHELP;
  END_VAR
  VAR_OUTPUT count : DINT; END_VAR
  count := UPPER_BOUND(MODULES, 1) - LOWER_BOUND(MODULES, 1) + 1;
END_FUNCTION_BLOCK
`;

const buildLib = (): StlibArchive => {
  const lib = compileStlib([{ source: LIB, fileName: "xexp.st" }], {
    name: "xexp-lib",
    version: "1.0.0",
    namespace: "xexp",
  });
  expect(lib.errors).toEqual([]);
  // Through JSON, as an archive on disk is read.
  return loadStlibFromString(JSON.stringify(lib.archive));
};

// Uses the block and none of its element types.
const PROJECT = `
PROGRAM Main
  VAR e : XEXPANSION; n : DINT; END_VAR
  n := e.count;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe("library block taking ARRAY [*] OF a library type", () => {
  it("lists the element types among the block's chunk deps", () => {
    const chunk = buildLib().chunks.find((c) => c.name === "XEXPANSION")!;
    const deps = chunk.deps.map((d) => d.name);
    // A struct, an enumeration (two-dimensional) and a block.
    expect(deps).toEqual(expect.arrayContaining(["XMOD", "XGRID", "XHELP"]));
  });

  it("emits them for a project that does not name them", () => {
    const result = compile(PROJECT, {
      headerFileName: "generated.hpp",
      libraries: [buildLib()],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    for (const name of ["XMOD", "XKIND", "XGRID", "XHELP"]) {
      expect(result.headerCode, name).toMatch(
        new RegExp(`\\b(struct|class|enum class) ${name}\\b`),
      );
    }
  });
});

(hasGpp ? describe : describe.skip)(
  "library block taking ARRAY [*] OF a library type, built",
  () => {
    it("compiles for a project that does not name the element types", () => {
      const result = compile(PROJECT, {
        headerFileName: "generated.hpp",
        libraries: [buildLib()],
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-vla-deps-"));
      try {
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
        fs.writeFileSync(
          path.join(dir, "main.cpp"),
          `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
int main() {
  g_config.INSTANCE0.run();
  std::printf("%d\\n", (int)g_config.INSTANCE0.N);
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
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("0");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
