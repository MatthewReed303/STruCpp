/**
 * A library block holding, by value, a block that the consumer supplies as a
 * program POU - the way the editor grafts a library's C/C++ block into the
 * program (it has no chunk of its own). The library chunk cannot be emitted
 * before that block's class (an instance member needs a complete type), so
 * the code generator holds it back until the program blocks it needs are
 * declared, and still ahead of the program blocks and programs that hold it.
 *
 * IEC 61131-3 Ed.3 6.6.3.2: a function block instance is declared like a
 * variable, in any function block or program, of any (library) FB type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compileStlib } from "../../src/library/library-compiler.js";
import { compile } from "../../src/index.js";
import { execSync } from "child_process";
import { hasGpp, createPCH, compileAndRunStandalone, CXX_STD } from "./test-helpers.js";

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");

const BASE = `
  FUNCTION_BLOCK BaseCounter
    VAR_INPUT
      Enable : BOOL;
    END_VAR
    VAR_OUTPUT
      Count : INT;
    END_VAR
    VAR
      internal : INT;
    END_VAR
    IF Enable THEN
      internal := internal + 1;
    END_IF;
    Count := internal;
  END_FUNCTION_BLOCK
`;

describe.skipIf(!hasGpp)("a library block holding a block the consumer supplies", () => {
  let tempDir: string;
  let pchPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-lib-native-dep-"));
    pchPath = createPCH(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function libraryB() {
    const libA = compileStlib([{ source: BASE, fileName: "base.st" }],
      { name: "base-lib", version: "1.0.0", namespace: "baselib" });
    expect(libA.success).toBe(true);
    const libB = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK DoubleCounter
              VAR_INPUT
                Enable : BOOL;
              END_VAR
              VAR_OUTPUT
                Count : INT;
              END_VAR
              VAR
                ctr1 : BaseCounter;
                ctr2 : BaseCounter;
              END_VAR
              ctr1(Enable := Enable);
              ctr2(Enable := Enable);
              Count := ctr1.Count + ctr2.Count;
            END_FUNCTION_BLOCK
          `,
          fileName: "double.st",
        },
      ],
      { name: "double-lib", version: "1.0.0", namespace: "dbllib", dependencies: [libA.archive] },
    );
    expect(libB.success).toBe(true);
    return libB.archive;
  }

  it("emits the library chunk after the program block it holds, and before the program holding it", () => {
    // The consumer: BaseCounter as a program POU (no base-lib loaded), a
    // program FB holding DoubleCounter declared BEFORE BaseCounter in the
    // source, and a program holding both.
    const userSource = `
      FUNCTION_BLOCK Holder
        VAR_OUTPUT
          Count : INT;
        END_VAR
        VAR
          dc : DoubleCounter;
        END_VAR
        dc(Enable := TRUE);
        Count := dc.Count;
      END_FUNCTION_BLOCK
      ${BASE}
      PROGRAM Main
        VAR
          h : Holder;
          dc : DoubleCounter;
        END_VAR
        h();
        dc(Enable := TRUE);
      END_PROGRAM
    `;
    const result = compile(userSource, { libraries: [libraryB()] });
    expect(result.success).toBe(true);
    const hdr = result.headerCode;
    const base = hdr.indexOf("class BASECOUNTER ");
    const dbl = hdr.indexOf("class DOUBLECOUNTER ");
    const holder = hdr.indexOf("class HOLDER ");
    expect(base).toBeGreaterThan(0);
    expect(dbl).toBeGreaterThan(base);
    expect(holder).toBeGreaterThan(dbl);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "lib_native_dep",
      mainCode: `
#include "generated.hpp"
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    prog.run();
    prog.run();
    std::cout << static_cast<int>(prog.H.COUNT) << " " << static_cast<int>(prog.DC.COUNT) << std::endl;
    return 0;
}
`,
    });
    // each run: both counters of each DoubleCounter count 1 (2 per run); 3 runs.
    // Holder reads dc.Count after its call: 6; the program's own dc: 6
    expect(stdout).toBe("6 6");
  });

  it("leaves a library block's function-block in-out out of the debug table (a pointer, debugged at its own name)", () => {
    // A library block taking another block as VAR_IN_OUT (as a device block
    // takes its MODBUS_NODE), that other block a program POU at the consumer.
    const libA = compileStlib([{ source: BASE, fileName: "base.st" }],
      { name: "base-lib", version: "1.0.0", namespace: "baselib" });
    const libR = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK Reader
              VAR_IN_OUT
                Link : BaseCounter;
              END_VAR
              VAR_OUTPUT
                Seen : INT;
              END_VAR
              Seen := Link.Count;
            END_FUNCTION_BLOCK
          `,
          fileName: "reader.st",
        },
      ],
      { name: "reader-lib", version: "1.0.0", namespace: "rdrlib", dependencies: [libA.archive] },
    );
    expect(libR.success).toBe(true);
    const result = compile(
      `${BASE}
      PROGRAM Main
        VAR
          link : BaseCounter;
          rd : Reader;
        END_VAR
        link(Enable := TRUE);
        rd(Link := link);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK T(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM P WITH T : Main;
        END_RESOURCE
      END_CONFIGURATION
    `,
      { headerFileName: "generated.hpp", libraries: [libR.archive] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.debugTableCpp).toBeTruthy();
    expect(result.debugTableCpp!).not.toMatch(/RD\.LINK\./);
    const dir = path.join(tempDir, "lib_inout_fb_debug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    const table = path.join(dir, "generated_debug.cpp");
    fs.writeFileSync(table, result.debugTableCpp!);
    let out = "";
    try {
      execSync(`g++ -std=${CXX_STD} -fsyntax-only -I"${RUNTIME_INCLUDE}" -I"${dir}" "${table}" 2>&1`, { encoding: "utf-8" });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? String(e);
    }
    expect(out).toBe("");
  });
});
