/**
 * The debugger on array elements C++ stores bare.
 *
 * A POU's own `ARRAY OF <enumeration | alias | subrange>` holds its elements
 * without the forcing wrapper every other leaf has. The debugger used to read
 * them as wrapped variables: the next element's low byte became the force
 * flag, so a value was read from two elements on, past the end of the array
 * for the last ones (UBSan: "load of value 2 ... not a valid value for type
 * 'bool'"). Such a leaf carries LEAF_FLAG_RAW, taken from its C++ type: it is
 * read and written in place, and refuses a force, having nowhere to keep one.
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
TYPE MyInt : INT; END_TYPE
TYPE Color : (RED, GREEN, BLUE); END_TYPE
TYPE Lvl : INT (LOW := 1, HIGH := 9); END_TYPE
TYPE Rng : INT(0..100); END_TYPE
TYPE CArr : ARRAY[1..3] OF Color; END_TYPE
PROGRAM Main
  VAR
    a1 : ARRAY[1..3] OF Color := [GREEN, BLUE, RED];
    a2 : ARRAY[1..3] OF MyInt := [700, 2, 300];
    a3 : ARRAY[1..2] OF Lvl := [HIGH, LOW];
    a4 : ARRAY[1..2] OF Rng := [42, 7];
    a5 : CArr := [BLUE, GREEN, RED];
    a6 : ARRAY[1..2, 1..2] OF Color := [BLUE, GREEN, RED, BLUE];
  END_VAR
  ;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

(hasGpp ? describe : describe.skip)("debugger on bare array elements", () => {
  it("reads and writes them in place and refuses to force them", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const leaf = (p: string): string => {
      const l = result.debugMap!.leaves.find((x) => x.path === p);
      expect(l, p).toBeDefined();
      return `${l!.arrayIdx}, ${l!.elemIdx}`;
    };
    const reads = [
      "INSTANCE0.A1[1]",
      "INSTANCE0.A1[2]",
      "INSTANCE0.A1[3]",
      "INSTANCE0.A2[1]",
      "INSTANCE0.A2[2]",
      "INSTANCE0.A2[3]",
      "INSTANCE0.A3[1]",
      "INSTANCE0.A3[2]",
      "INSTANCE0.A4[1]",
      "INSTANCE0.A4[2]",
      "INSTANCE0.A5[1]",
      "INSTANCE0.A6[2][1]",
      "INSTANCE0.A6[2][2]",
    ];
    const main = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp::debug;
static int rd(uint8_t a, uint16_t e) { uint8_t b[8] = {0}; int16_t v = 0; if (!handle_read(a, e, b)) return -1; std::memcpy(&v, b, 2); return v; }
int main() {
  g_config.INSTANCE0.run();
${reads.map((p) => `  std::printf("%d ", rd(${leaf(p)}));`).join("\n")}
  const int16_t two = 2, five = 55;
  uint8_t w = handle_write(${leaf("INSTANCE0.A1[1]")}, reinterpret_cast<const uint8_t*>(&two), 2);
  uint8_t w2 = handle_write(${leaf("INSTANCE0.A2[3]")}, reinterpret_cast<const uint8_t*>(&five), 2);
  uint8_t f = handle_set(${leaf("INSTANCE0.A1[2]")}, true, reinterpret_cast<const uint8_t*>(&two), 2);
  uint8_t u = handle_set(${leaf("INSTANCE0.A1[2]")}, false, nullptr, 0);
  uint8_t fw = handle_set(${leaf("INSTANCE0.A5[1]")}, true, reinterpret_cast<const uint8_t*>(&two), 2);
  auto& p = g_config.INSTANCE0;
  std::printf("| %d %d %d %d %d | %d %d %d %d\\n", (int)p.A1[1], (int)p.A2[3], (int)p.A1[2], (int)p.A2[2],
              (int)static_cast<strucpp::COLOR>(p.A5[1]), w == STATUS_OK, w2 == STATUS_OK,
              f == STATUS_READ_ONLY && u == STATUS_OK, fw == STATUS_OK);
  return 0;
}
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-bare-elems-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );
      fs.writeFileSync(path.join(dir, "main.cpp"), main);
      const bin = path.join(dir, "run");
      execSync(
        `g++ -std=${CXX_STD} -fsanitize=address,undefined -fno-sanitize-recover=all ` +
          `-I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" "${path.join(dir, "main.cpp")}" ` +
          `"${path.join(dir, "generated.cpp")}" "${path.join(dir, "generated_debug.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      // Elements as declared, then: A1[1] written to BLUE (2), A2[3] to 55, a
      // force on A1[2] refused (it stays BLUE), A2[2] untouched; a wrapped
      // element (CArr) still forces.
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
        "1 2 0 700 2 300 9 1 42 7 2 0 2 | 2 55 2 2 2 | 1 1 1 1",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The debug map's `raw` must say what the table's LEAF_FLAG_RAW says. The map
 * works it out from the ST types (`storedBare`), the table from the C++ types
 * (`leaf_raw_flag`); this compiles a spread of element types, in a POU, in
 * TYPEs, in globals, in a block and behind an in-out, and compares the two for
 * every leaf.
 */
const MATRIX = `
TYPE MyInt : INT; END_TYPE
TYPE MyStr : STRING(8); END_TYPE
TYPE MyTime : TIME; END_TYPE
TYPE Color : (RED, GREEN, BLUE); END_TYPE
TYPE Shade : Color; END_TYPE
TYPE Lvl : INT (LOW := 1, HIGH := 9); END_TYPE
TYPE Rng : INT(0..100); END_TYPE
TYPE RngAlias : Rng; END_TYPE
TYPE Pt : STRUCT x : INT; c : Color; END_STRUCT; END_TYPE
TYPE CArr : ARRAY[1..2] OF Color; END_TYPE
TYPE IArr : ARRAY[1..2] OF MyInt; END_TYPE
TYPE SArr : ARRAY[1..2] OF Shade; END_TYPE
TYPE RArr : ARRAY[1..2] OF Rng; END_TYPE
TYPE Holder : STRUCT
  cs : ARRAY[1..2] OF Color;
  ms : ARRAY[1..2] OF MyInt;
  ss : ARRAY[1..2] OF Shade;
  ca : CArr;
END_STRUCT; END_TYPE
FUNCTION_BLOCK Blk
  VAR_INPUT bi : ARRAY[1..2] OF Lvl; END_VAR
  VAR bc : ARRAY[1..2] OF Color; bh : Holder; END_VAR
  ;
END_FUNCTION_BLOCK
FUNCTION_BLOCK IoBlk
  VAR_IN_OUT io : ARRAY[1..2] OF Color; im : ARRAY[1..2] OF MyInt; END_VAR
  ;
END_FUNCTION_BLOCK
PROGRAM Main
  VAR
    a1 : ARRAY[1..2] OF Color;
    a2 : ARRAY[1..2] OF MyInt;
    a3 : ARRAY[1..2] OF Lvl;
    a4 : ARRAY[1..2] OF Rng;
    a5 : CArr;
    a6 : IArr;
    a7 : SArr;
    a8 : RArr;
    a9 : ARRAY[1..2] OF Shade;
    a10 : ARRAY[1..2] OF RngAlias;
    a11 : ARRAY[1..2] OF MyTime;
    a12 : ARRAY[1..2] OF MyStr;
    a13 : ARRAY[1..2] OF Pt;
    a14 : ARRAY[1..2] OF CArr;
    a15 : ARRAY[1..2] OF INT;
    a16 : Holder;
    a17 : ARRAY[1..2] OF Holder;
    a18 : ARRAY[1..2] OF Blk;
    c1 : Color;
    m1 : MyInt;
    ib : IoBlk;
  END_VAR
  ib(io := a1, im := a2);
END_PROGRAM
CONFIGURATION Config0
  VAR_GLOBAL
    g1 : ARRAY[1..2] OF Color;
    g2 : ARRAY[1..2] OF MyInt;
    g3 : CArr;
  END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

(hasGpp ? describe : describe.skip)("debug map raw flag", () => {
  it("marks exactly the leaves the table flags LEAF_FLAG_RAW", () => {
    const result = compile(MATRIX, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const leaves = result.debugMap!.leaves;
    const main = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp::debug;
int main() {
  for (uint8_t a = 0; a < debug_array_count; ++a)
    for (uint16_t e = 0; e < debug_array_counts[a]; ++e)
      std::printf("%d", (debug_arrays[a][e].flags & LEAF_FLAG_RAW) ? 1 : 0);
  return 0;
}
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-raw-map-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );
      fs.writeFileSync(path.join(dir, "main.cpp"), main);
      const bin = path.join(dir, "run");
      execSync(
        `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}" ` +
          `"${path.join(dir, "generated_debug.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv },
      );
      const bits = execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
      // Table order is (arrayIdx, elemIdx); compare leaf by leaf by path.
      const ordered = [...leaves].sort(
        (x, y) => x.arrayIdx - y.arrayIdx || x.elemIdx - y.elemIdx,
      );
      expect(bits.length).toBe(ordered.length);
      const table = Object.fromEntries(
        ordered.map((l, i) => [l.path, bits[i] === "1"]),
      );
      const map = Object.fromEntries(
        ordered.map((l) => [l.path, l.raw === true]),
      );
      expect(map).toEqual(table);

      // And the expected answer, so a regression on both sides still fails.
      const rawPaths = ordered.filter((l) => l.raw).map((l) => l.path);
      const roots = [
        ...new Set(rawPaths.map((p) => p.replace(/\[\d+\].*$/, ""))),
      ].sort();
      expect(roots).toEqual(
        [
          "G1",
          "G2",
          "INSTANCE0.A1",
          "INSTANCE0.A10",
          "INSTANCE0.A11",
          "INSTANCE0.A16.MS",
          "INSTANCE0.A16.SS",
          "INSTANCE0.A17",
          "INSTANCE0.A18",
          "INSTANCE0.A2",
          "INSTANCE0.A3",
          "INSTANCE0.A4",
          "INSTANCE0.A6",
          "INSTANCE0.A7",
          "INSTANCE0.A8",
          "INSTANCE0.A9",
          "INSTANCE0.IB.IM",
          "INSTANCE0.IB.IO",
        ].sort(),
      );
      // A force-capable element is never marked.
      for (const p of [
        "INSTANCE0.A5[1]",
        "INSTANCE0.A15[1]",
        "INSTANCE0.A16.CS[1]",
        "INSTANCE0.A16.CA[1]",
        "INSTANCE0.C1",
        "INSTANCE0.M1",
        "G3[1]",
      ]) {
        expect(map[p], p).toBe(false);
      }
      expect(rawPaths).toContain("INSTANCE0.A18[1].BI[1]");
      expect(rawPaths).toContain("INSTANCE0.A18[1].BC[1]");
      expect(rawPaths).not.toContain("INSTANCE0.A18[1].BH.CS[1]");
      // An in-out over such an array is a raw view too, and still read-only.
      const io = ordered.find((l) => l.path === "INSTANCE0.IB.IO[1]");
      expect(io).toMatchObject({ raw: true, indirect: true, readOnly: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
