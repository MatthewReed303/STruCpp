// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * A library FUNCTION's manifest lists its parameters — VAR_INPUT, VAR_OUTPUT
 * and VAR_IN_OUT — and nothing else. Its VAR, VAR_TEMP and VAR_EXTERNAL
 * variables are the function's own; listed as inputs, a consumer refused a
 * correct call ("missing required inputs"). A parameter or return type keeps
 * its declared STRING length.
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
FUNCTION STATUS_TEXT : STRING(30)
  VAR_INPUT st : INT; f : BOOL; END_VAR
  VAR_IN_OUT seen : INT; END_VAR
  VAR_OUTPUT code : INT; note : STRING(12); END_VAR
  VAR pre : STRING; name : STRING(10); END_VAR
  VAR_TEMP n : INT; END_VAR
  pre := 'st';
  name := '=';
  n := st * 2;
  seen := seen + 1;
  code := n;
  note := 'seen';
  IF f THEN
    STATUS_TEXT := CONCAT(CONCAT(pre, name), INT_TO_STRING(n));
  ELSE
    STATUS_TEXT := 'off';
  END_IF;
END_FUNCTION
`;

const buildLib = (): StlibArchive => {
  const lib = compileStlib([{ source: LIB, fileName: "status.st" }], {
    name: "status-lib",
    version: "1.0.0",
    namespace: "status",
  });
  expect(lib.errors).toEqual([]);
  // Through JSON, as an archive on disk is read.
  return loadStlibFromString(JSON.stringify(lib.archive));
};

describe("library FUNCTION parameters in the manifest", () => {
  it("lists only the parameters, with their declared lengths", () => {
    const fn = buildLib().manifest.functions.find(
      (f) => f.name === "STATUS_TEXT",
    )!;
    expect(fn.parameters.map((p) => [p.name, p.direction])).toEqual([
      ["ST", "input"],
      ["F", "input"],
      ["SEEN", "inout"],
      ["CODE", "output"],
      ["NOTE", "output"],
    ]);
    expect(fn.returnType).toBe("STRING");
    expect(fn.returnMaxLength).toBe(30);
  });

  it("accepts a call that supplies the parameters only", () => {
    const result = compile(
      `PROGRAM Main
  VAR s : STRING(30); s2 : STRING(30); k : INT; c : INT; END_VAR
  s := STATUS_TEXT(4, TRUE, k, c);
  s2 := STATUS_TEXT(st := 1, f := FALSE, seen := k, code => c);
END_PROGRAM`,
      { headerFileName: "generated.hpp", libraries: [buildLib()] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });
});

(hasGpp ? describe : describe.skip)(
  "library FUNCTION with locals, called",
  () => {
    it("runs with the values its body computes, outputs left out included", () => {
      const result = compile(
        `PROGRAM Main
  VAR s : STRING(30); s2 : STRING(30); s3 : STRING(30); k : INT; c : INT; END_VAR
  s := STATUS_TEXT(4, TRUE, k, c);
  s2 := STATUS_TEXT(st := 1, f := FALSE, seen := k, code => c);
  s3 := STATUS_TEXT(5, TRUE, k);   (* the outputs left out: temporaries *)
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`,
        { headerFileName: "generated.hpp", libraries: [buildLib()] },
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libfn-"));
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
  std::printf("%s|%s|%s|%d|%d\\n", p.S.get().c_str(), p.S2.get().c_str(), p.S3.get().c_str(), (int)p.K, (int)p.C);
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
          "st=8|off|st=10|3|2",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
