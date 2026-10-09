/**
 * Enumerated types and data types with named values in standard functions.
 *
 * - An enumerated value (IEC 61131-3 Ed.3 6.4.4.2) takes SEL, MUX, EQ and NE
 *   (Table 38), whichever spelling each input has: `MUX(k, RED, c)` mixes an
 *   enumerator with a variable of the same type.
 * - A value of a data type with named values (6.4.4.3) is a value of its base
 *   type, "other constants can be assigned, or can arise through
 *   calculations", so every standard function that takes the base type takes
 *   it: MAX, MIN, LIMIT, ADD, GT, ...
 * - Any other standard function given an enumerated value is refused by the
 *   compiler with the rule, rather than failing in C++.
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

const TYPES = `
TYPE Color : (RED, GREEN, BLUE); END_TYPE
TYPE Lvl : INT (LOW := 1, MID := 5, HIGH := 9); END_TYPE
`;

const CONFIG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

(hasGpp ? describe : describe.skip)(
  "enumerations in standard functions, compiled",
  () => {
    it("selects with MUX and SEL over mixed spellings, and computes named values as their base type", () => {
      const result = compile(
        `${TYPES}
PROGRAM Main
  VAR
    k : INT := 1;
    c2 : Color := BLUE;
    m0, m1, m2, m3, s0 : Color;
    l2 : Lvl := 7;
    lm : Lvl;
    mx, mn, lim, add, mxl, nested : INT;
    gt : BOOL;
  END_VAR
  m0 := MUX(k, RED, c2);
  m1 := MUX(k, c2, GREEN, RED);
  m2 := MUX(5, c2, GREEN, RED);
  m3 := MUX(0, GREEN, c2);
  s0 := SEL(TRUE, c2, GREEN);
  lm := MUX(k, LOW, l2);
  mx := MAX(l2, 3);
  mn := MIN(l2, LOW);
  lim := LIMIT(LOW, 20, HIGH);
  add := ADD(l2, 1, MID);
  mxl := MAX(l2, HIGH);
  gt := GT(l2, MID);
  nested := LIMIT(LOW, MAX(l2, 3), HIGH);
END_PROGRAM
${CONFIG}`,
        { headerFileName: "generated.hpp" },
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enum-std-"));
      try {
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
        fs.writeFileSync(
          path.join(dir, "main.cpp"),
          `#include "generated.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
using strucpp::COLOR;
int main() {
  auto& p = g_config.INSTANCE0;
  p.run();
  std::printf("%d %d %d %d %d %d %d %d %d %d %d %d %d\\n",
    (int)static_cast<COLOR>(p.M0), (int)static_cast<COLOR>(p.M1), (int)static_cast<COLOR>(p.M2),
    (int)static_cast<COLOR>(p.M3), (int)static_cast<COLOR>(p.S0), (int)static_cast<strucpp::LVL>(p.LM),
    (int)p.MX, (int)p.MN, (int)p.LIM, (int)p.ADD, (int)p.MXL, (int)p.GT, (int)p.NESTED);
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
        // MUX(1, RED, BLUE) = BLUE (2); MUX(1, BLUE, GREEN, RED) = GREEN (1);
        // MUX(5, …) out of range = the last, RED (0); MUX(0, GREEN, …) = GREEN;
        // SEL(TRUE, BLUE, GREEN) = GREEN; MUX(1, LOW, 7) = 7; MAX(7, 3) = 7;
        // MIN(7, LOW) = 1; LIMIT(1, 20, 9) = 9; ADD(7, 1, 5) = 13;
        // MAX(7, HIGH) = 9; GT(7, MID) = TRUE; LIMIT(LOW, MAX(7, 3), HIGH) = 7.
        expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe(
          "2 1 0 1 1 7 7 1 9 13 9 1 7",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe("enumerated values outside Table 38", () => {
  it("are refused with the rule, not left to fail in C++", () => {
    const result = compile(
      `${TYPES}
PROGRAM Main
  VAR c, c2 : Color; b : BOOL; END_VAR
  c := MAX(c, c2);
  b := GT(c, c2);
  c := SEL(b, c, c2);
  b := EQ(c, GREEN);
END_PROGRAM`,
      { headerFileName: "generated.hpp" },
    );
    const messages = result.errors.map((e) => e.message);
    expect(messages.filter((m) => m.includes("Table 38"))).toHaveLength(4);
    expect(
      messages.every((m) => !m.includes("'SEL'") && !m.includes("'EQ'")),
    ).toBe(true);
  });
});
