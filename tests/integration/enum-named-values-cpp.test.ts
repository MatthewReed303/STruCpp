/**
 * Enumerations and data types with named values, compiled and run.
 *
 * IEC 61131-3 Ed.3 6.4.4.2: an enumerated value is one of its type's names and
 * nothing else; Table 38 admits SEL, MUX, EQ and NE on one, and Figure 11 has
 * no conversion for one. 6.4.4.3: a data type with named values
 * (`T : USINT (A := 0, ...)`) holds values of its base type, so a constant or a
 * calculation may be assigned to it, and its value converts as the base does.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  CXX_STD,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;
const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");

const TYPES = `
TYPE
  Light : USINT (RED := 1, AMBER := 2, GREEN := 3) := GREEN;
  Colors : DWORD (CRed := 16#00FF0000, CGreen := 16#0000FF00, CBlue := 16#000000FF,
                  CWhite := CRed OR CGreen OR CBlue, CBlack := CRed AND CGreen AND CBlue) := CGreen;
  Plain : (P_A, P_B, P_C);
  Holder : STRUCT l : Light; p : Plain; END_STRUCT;
END_TYPE
FUNCTION_BLOCK FB_L
VAR_INPUT lin : Light; num : INT; END_VAR
VAR_OUTPUT lout : Light; n : INT; END_VAR
  lout := lin;
  n := lin;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_P
VAR_INPUT pin : Plain; num : INT; END_VAR
VAR_IN_OUT io : Plain; END_VAR
VAR_OUTPUT pout : Plain; n : INT; END_VAR
  pout := pin;
END_FUNCTION_BLOCK
FUNCTION F_INT : INT
VAR_INPUT v : INT; END_VAR
  F_INT := v;
END_FUNCTION
`;

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

const program = (vars: string, body: string) => `${TYPES}
PROGRAM Main
VAR
  l : Light; l2 : Light; h : Holder; fbl : FB_L; fbp : FB_P;
  p : Plain; p2 : Plain; i : INT; j : INT; k : INT; u : USINT;
  b : BOOL; c : Colors; d : DWORD;
  ${vars}
END_VAR
  ${body}
END_PROGRAM${CFG}`;

const messages = (vars: string, body: string) => {
  const result = compile(program(vars, body), {});
  return {
    errors: result.errors.map((e) => e.message),
    warnings: result.warnings.map((w) => w.message),
  };
};

describe("enumerations and data types with named values: the semantic check", () => {
  it("stores a named-values type at its base width and an enumeration at INT", () => {
    const result = compile(program("", ""), {});
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain(
      "struct LIGHT__NAMED { enum LIGHT : USINT_t { RED = 1, AMBER = 2, GREEN = 3 }; };",
    );
    expect(result.headerCode).toContain(
      "enum class PLAIN : INT_t { P_A, P_B, P_C };",
    );
    expect(result.headerCode).toContain("CWHITE = CRED | CGREEN | CBLUE");
    expect(result.headerCode).toContain("CBLACK = CRED & CGREEN & CBLUE");
  });

  it("allows what 6.4.4.3 allows on named values", () => {
    expect(
      messages(
        "",
        `l := 27; l := AMBER + 1; l := Light#RED + 1; i := l; u := l; d := c;
  b := l = 27; b := l > AMBER; b := l = l2; b := AMBER < 9;
  fbl(lin := 2, num := l); fbl(lin := u, n => i); fbl(lin := l, n => l2);
  j := F_INT(l); j := F_INT(v := l);`,
      ).errors,
    ).toEqual([]);
  });

  it("refuses a named value of one type assigned to another named-values type", () => {
    expect(messages("", `l := CRed;`).errors).toEqual([
      "Cannot assign COLORS to LIGHT",
    ]);
  });

  it("refuses an enumerated value where an integer is wanted (Figure 11)", () => {
    const { errors } = messages(
      "",
      `i := p;
  p := 1;
  b := p = 1;
  i := p + 1;
  fbp(pin := P_A, num := p, io := p2);
  j := F_INT(p);
  j := F_INT(v := p2);
  fbl(lin := RED, num := fbp.pout);`,
    );
    expect(errors).toEqual([
      "Cannot assign PLAIN to INT",
      "Cannot assign INT to PLAIN",
      "Cannot compare PLAIN = INT: an enumerated value compares only with a value of its own type (IEC 61131-3 Table 38)",
      "Operator '+' is not defined for the enumeration PLAIN: IEC 61131-3 Table 38 admits only SEL, MUX, EQ and NE",
      "Input 'NUM' of 'FBP' is INT and cannot take PLAIN: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
      "Input 'V' of 'F_INT' is INT and cannot take PLAIN: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
      "Input 'V' of 'F_INT' is INT and cannot take PLAIN: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
      "Input 'NUM' of 'FBL' is INT and cannot take PLAIN: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
    ]);
  });

  it("refuses an enumerated output sent to an integer, and an integer sent to an enumerated input", () => {
    const { errors } = messages("", `fbp(pin := 1, pout => i);`);
    expect(errors).toEqual([
      "Input 'PIN' of 'FBP' is PLAIN and cannot take INT: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
      "Output 'POUT' of 'FBP' is PLAIN and cannot take INT: IEC 61131-3 defines no conversion of an enumerated value (6.6.1.6, Figure 11; Table 38)",
    ]);
  });

  it("refuses a converted argument to an in-out, named values included (6.6.1.6 rule 6)", () => {
    expect(messages("", `fbp(pin := P_A, io := l);`).errors).toEqual([
      "In-out 'IO' of 'FBP' is PLAIN and cannot take LIGHT: an in-out takes no type conversion (IEC 61131-3 6.6.1.6 rule 6)",
    ]);
  });

  it("keeps what already worked on an enumeration: its own type, SEL and CASE", () => {
    expect(
      messages(
        "",
        `p := P_B; b := p = p2; b := p <> P_C; p2 := SEL(b, p, P_A);
  fbp(pin := p, io := p2, pout => p);
  CASE p OF P_A: i := 1; END_CASE;`,
      ).errors,
    ).toEqual([]);
  });

  it("refuses a base type a named value cannot have, and a value outside the base's range", () => {
    const declared = (types: string) =>
      compile(
        `TYPE ${types} END_TYPE
PROGRAM Main VAR x : INT; END_VAR x := 1; END_PROGRAM${CFG}`,
        {},
      ).errors.map((e) => e.message);
    expect(declared("E : REAL (A := 1);")).toEqual([
      "The base type of 'E' must be an integer or bit-string type, not REAL: its named values are integers",
    ]);
    expect(declared("E : USINT (A := 255, B);")).toEqual([
      "'B' := 256 is out of range for USINT (0..255)",
    ]);
    expect(declared("E : SINT (A := -129);")).toEqual([
      "'A' := -129 is out of range for SINT (-128..127)",
    ]);
    expect(declared("E : (A := 40000);")).toEqual([
      "'A' := 40000 is out of range for INT (-32768..32767)",
    ]);
  });

  it("converts USINT to INT implicitly, as Figure 12 does", () => {
    expect(messages("", `i := u; d := u;`).errors).toEqual([]);
  });
});

describeIfGpp(
  "enumerations and data types with named values: compiled and run",
  () => {
    let tempDir: string;
    let pchPath: string;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-named-values-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("computes with named values in a STRUCT, on FB pins and in CASE", () => {
      const result = compile(
        program(
          "l3 : Light := 9; l4 : Light;",
          `l := 27;
  l2 := AMBER + 1;
  i := l2;
  u := l;
  h.l := RED;
  h.p := P_C;
  fbl(lin := h.l, num := l2, n => j);
  l4 := fbl.lout;
  c := Colors#CWhite;
  d := c;
  CASE l2 OF GREEN: k := 1; ELSE k := 2; END_CASE;
  b := (l = 27) AND (l2 > AMBER) AND (l < 100) AND (l2 = GREEN) AND (fbl.n = 1);`,
        ),
        {},
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode ?? "",
        cppCode: result.cppCode ?? "",
        testName: "named_values_run",
        mainCode: `
#include <iostream>
int main() {
  using namespace strucpp;
  static_assert(sizeof(LIGHT) == 1, "a USINT named-values type is one byte");
  static_assert(sizeof(PLAIN) == 2, "an enumeration is stored as INT");
  static_assert(sizeof(COLORS) == 4, "a DWORD named-values type is four bytes");
  Program_MAIN prog;
  prog.run();
  std::cout << (int)prog.L << " " << (int)prog.L2 << " " << prog.I << " " << (int)prog.U
            << " " << (int)prog.H.L << " " << (int)(prog.H.P == PLAIN::P_C)
            << " " << prog.J << " " << (int)prog.L4 << " " << prog.D << " " << (int)COLORS::CBLACK
            << " " << prog.K << " " << (int)prog.L3 << " " << (bool)prog.B << "\\n";
  return 0;
}`,
      });
      expect(out).toBe("27 3 3 27 1 1 1 1 16777215 0 1 9 1");
    });

    it("forces an enumeration and a named-values variable through the debugger", () => {
      // The debug leaf of an enumeration is INT and of `Light` USINT, and the
      // force writes IECVar<INT_t> / IECVar<USINT_t>: the C++ storage has to be
      // that wide, or the forced flag lands in the middle of the value.
      const result = compile(
        `${TYPES}
PROGRAM Main
VAR p : Plain; h : Holder; l : Light; END_VAR
  p := P_A;
  h.p := P_A;
  h.l := RED;
  l := AMBER;
END_PROGRAM${CFG}`,
        { headerFileName: "generated.hpp" },
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const leaf = (p: string) => {
        const found = result.debugMap!.leaves.find((l) => l.path === p);
        expect(found, `no leaf for ${p}`).toBeTruthy();
        return found!;
      };
      expect(leaf("INSTANCE0.P").type).toBe("INT");
      expect(leaf("INSTANCE0.H.L").type).toBe("USINT");
      const idx = (p: string) => `${leaf(p).arrayIdx}, ${leaf(p).elemIdx}`;

      const dir = path.join(tempDir, "force");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );
      fs.writeFileSync(
        path.join(dir, "main.cpp"),
        `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
using namespace strucpp::debug;
int fails = 0;
static void chk(const char* what, bool ok) { if (!ok) { printf("FAIL %s\\n", what); ++fails; } }
static int rd(uint8_t a, uint16_t e) {
  unsigned char buf[8] = {0};
  uint16_t n = handle_read(a, e, buf);
  int v = 0;
  if (n == 1) v = buf[0]; else { int16_t s; memcpy(&s, buf, 2); v = s; }
  return v;
}
int main() {
  auto& prog = g_config.INSTANCE0;
  const unsigned char two[2] = {2, 0};
  const unsigned char three[1] = {3};
  chk("force p", handle_set(${idx("INSTANCE0.P")}, true, two, 2) == STATUS_OK);
  chk("force h.p", handle_set(${idx("INSTANCE0.H.P")}, true, two, 2) == STATUS_OK);
  chk("force h.l", handle_set(${idx("INSTANCE0.H.L")}, true, three, 1) == STATUS_OK);
  chk("force l", handle_set(${idx("INSTANCE0.L")}, true, three, 1) == STATUS_OK);
  for (int scan = 0; scan < 3; ++scan) prog.run();
  chk("p stays forced", prog.P == PLAIN::P_C && rd(${idx("INSTANCE0.P")}) == 2);
  chk("h.p stays forced", prog.H.P == PLAIN::P_C && rd(${idx("INSTANCE0.H.P")}) == 2);
  chk("h.l stays forced", prog.H.L == LIGHT::GREEN && rd(${idx("INSTANCE0.H.L")}) == 3);
  chk("l stays forced", prog.L == LIGHT::GREEN && rd(${idx("INSTANCE0.L")}) == 3);
  chk("unforce p", handle_set(${idx("INSTANCE0.P")}, false, two, 2) == STATUS_OK);
  chk("unforce h.l", handle_set(${idx("INSTANCE0.H.L")}, false, three, 1) == STATUS_OK);
  prog.run();
  chk("p follows the program again", prog.P == PLAIN::P_A && rd(${idx("INSTANCE0.P")}) == 0);
  chk("h.l follows the program again", prog.H.L == LIGHT::RED && rd(${idx("INSTANCE0.H.L")}) == 1);
  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`,
      );
      const bin = path.join(dir, "force");
      execSync(
        `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE}" -I"${dir}" ` +
          `-o "${bin}" "${path.join(dir, "main.cpp")}" ` +
          `"${path.join(dir, "generated.cpp")}" "${path.join(dir, "generated_debug.cpp")}"`,
        { encoding: "utf-8" },
      );
      expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
    });

    it("carries a library's named-values type to a project: values, layout and debug width", () => {
      const lib = compileStlib(
        [
          {
            fileName: "status.st",
            source: `
TYPE
  LStop : (S_NONE, S_DONE, S_FAULT);
  LStat : USINT (ST_IDLE := 0, ST_RUN := 1, ST_FAULT := 9);
END_TYPE
FUNCTION_BLOCK LFB
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT stop : LStop; stat : LStat; END_VAR
  IF i > 0 THEN stop := S_DONE; stat := ST_FAULT; END_IF;
END_FUNCTION_BLOCK`,
          },
        ],
        { name: "status-lib", version: "1.0.0", namespace: "statuslib" },
      );
      expect(lib.errors).toEqual([]);
      const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
      expect(
        archive.manifest.types.find((t) => t.name === "LSTAT")?.baseType,
      ).toBe("USINT");

      const result = compile(
        `
TYPE Rec : STRUCT s : LStop; t : LStat; END_STRUCT; END_TYPE
PROGRAM Main
VAR f : LFB; r : Rec; n : INT; b : BOOL; END_VAR
  f(i := 1);
  r.s := f.stop;
  r.t := f.stat;
  n := f.stat;
  b := f.stat >= ST_RUN;
END_PROGRAM${CFG}`,
        { headerFileName: "generated.hpp", libraries: [archive] },
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      // A STRUCT holding a library enumeration has its layout table, and holds
      // it in the forceable wrapper the debugger addresses.
      expect(result.warnings.map((w) => w.message)).toEqual([]);
      expect(result.headerCode).toContain("IEC_LSTOP S");
      expect(result.headerCode).toContain("IEC_LSTAT T");
      const types = Object.fromEntries(
        result.debugMap!.leaves.map((l) => [l.path, l.type]),
      );
      expect(types["INSTANCE0.R.S"]).toBe("INT");
      expect(types["INSTANCE0.R.T"]).toBe("USINT");
      expect(types["INSTANCE0.F.STAT"]).toBe("USINT");

      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode ?? "",
        cppCode: result.cppCode ?? "",
        testName: "named_values_library",
        mainCode: `
#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN prog;
  prog.run();
  std::cout << prog.N << " " << (bool)prog.B << " " << (int)prog.R.T << " " << (int)(prog.R.S == LSTOP::S_DONE) << "\\n";
  return 0;
}`,
      });
      expect(out).toBe("9 1 9 1");
    });
  },
);
