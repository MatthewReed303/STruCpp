/**
 * A STRUCT's initial values as a constant, not code.
 *
 * Every wrapper a STRUCT member can be (IECVar, STRING, enumeration, subrange,
 * ARRAY, a nested STRUCT with its own initial values) constructs as a constant
 * expression, so an object of the type with static storage is constant-
 * initialised: a data image, with no start-up store per member. These tests
 * check that a C++20 build accepts `constinit` on such objects, and that the
 * values are the same whichever way the object is built — constant, at run
 * time, or re-built in place as a cold restart does.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, RUNTIME_INCLUDE_PATH, cxxEnv } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `
TYPE Mode : (OFF, AUTO, MANUAL); END_TYPE
TYPE Lim : STRUCT sp : REAL := 5.0; db : REAL := 0.5; m : Mode := AUTO; on : BOOL; END_STRUCT; END_TYPE
TYPE Cell : STRUCT x : INT := 3; tag : STRING(8) := 'ab'; END_STRUCT; END_TYPE
TYPE Rec : STRUCT
  n : INT := 7;
  hi : Lim := (sp := 9.0, m := MANUAL);
  lo : Lim;
  cells : ARRAY[1..3] OF Cell;
  stage : ARRAY[1..2] OF Lim := [(sp := 1.0), (sp := 2.0, on := TRUE)];
  grid : ARRAY[1..2, 0..2] OF DINT := [1, 2, 3, 4, 5, 6];
  t : TIME := T#5s;
  txt : STRING(20) := 'hello';
  r : INT(0..100) := 50;
END_STRUCT; END_TYPE
PROGRAM Main
  VAR r1 : Rec; END_VAR
  r1.n := r1.n + 1;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

/** Prints every member of a Rec, one line. */
const DUMP = `
static void dump(const char* tag, const strucpp::REC& r) {
  std::printf("%s n=%d hi=%g,%g,%d,%d lo=%g,%g,%d,%d", tag, (int)r.N, (double)r.HI.SP, (double)r.HI.DB,
              (int)static_cast<strucpp::MODE>(r.HI.M), (int)r.HI.ON, (double)r.LO.SP, (double)r.LO.DB,
              (int)static_cast<strucpp::MODE>(r.LO.M), (int)r.LO.ON);
  for (int i = 1; i <= 3; ++i) std::printf(" c%d=%d,%s", i, (int)r.CELLS[i].X, r.CELLS[i].TAG.get().c_str());
  for (int i = 1; i <= 2; ++i) std::printf(" s%d=%g,%d", i, (double)r.STAGE[i].SP, (int)r.STAGE[i].ON);
  for (int i = 1; i <= 2; ++i) for (int j = 0; j <= 2; ++j) std::printf(" g=%d", (int)r.GRID(i, j));
  std::printf(" t=%lld txt=%s r=%d\\n", (long long)r.T, r.TXT.get().c_str(), (int)r.R);
}
`;

describeIfGpp("STRUCT initial values are a constant", () => {
  const run = (std: string, main: string): string => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-struct-const-"));
    try {
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(path.join(dir, "main.cpp"), main);
      const bin = path.join(dir, "run");
      execSync(
        `g++ -std=${std} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}"`,
        { encoding: "utf-8", env: cxxEnv, stdio: "pipe" },
      );
      return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const EXPECTED =
    "n=7 hi=9,0.5,2,0 lo=5,0.5,1,0 c1=3,ab c2=3,ab c3=3,ab s1=1,0 s2=2,1 " +
    "g=1 g=2 g=3 g=4 g=5 g=6 t=5000000000 txt=hello r=50";

  it("constant-initialises an object of the type (C++20 constinit), with the declared values", () => {
    const out = run(
      "c++20",
      `#include "generated.hpp"
#include <cstdio>
#include <new>
constinit strucpp::REC k_const{};
${DUMP}
int main() {
  dump("const", k_const);
  strucpp::REC* r = new strucpp::REC();
  dump("heap", *r);
  r->N = 99; r->TXT = "changed"; r->HI.SP = 1;
  r->~REC();
  new (r) strucpp::REC();      // re-built in place, as a cold restart does
  dump("again", *r);
  delete r;
  return 0;
}
`,
    );
    expect(out.split("\n")).toEqual([
      `const ${EXPECTED}`,
      `heap ${EXPECTED}`,
      `again ${EXPECTED}`,
    ]);
  });

  it("keeps the same values in a C++14 build, where nested initial values are built at run time", () => {
    const out = run(
      "c++14",
      `#include "generated.hpp"
#include <cstdio>
strucpp::REC k_static;
strucpp::Configuration_CONFIG0 g_config;
${DUMP}
int main() {
  dump("static", k_static);
  g_config.INSTANCE0.run();
  dump("program", g_config.INSTANCE0.R1);
  return 0;
}
`,
    );
    expect(out.split("\n")).toEqual([
      `static ${EXPECTED}`,
      `program ${EXPECTED.replace("n=7", "n=8")}`,
    ]);
  });
});
