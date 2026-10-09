/**
 * Signed duration literals (IEC 61131-3 Ed.3 6.3.4, Table 8): "both positive
 * and negative values are allowed for durations" — `T#-14ms`, `TIME#-14ms`.
 * The sign follows the prefix and applies to the whole interval. `-T#14ms`
 * (a negated literal) keeps working and means the same.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { tokenize } from "../../src/frontend/lexer.js";
import {
  hasGpp,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

describe("signed duration literals lex as one literal", () => {
  it("takes the sign after the prefix, for every prefix", () => {
    for (const lit of [
      "T#-14ms",
      "TIME#-14ms",
      "LT#-14.7s",
      "LTIME#-5m_30s",
      "t#+1h",
      "T#-1d2h",
    ]) {
      const { tokens, errors } = tokenize(`x := ${lit};`);
      expect(errors).toEqual([]);
      expect(tokens.map((t) => t.tokenType.name)).toContain("TimeLiteral");
      expect(
        tokens.find((t) => t.tokenType.name === "TimeLiteral")!.image,
      ).toBe(lit.toUpperCase());
    }
  });
});

(hasGpp ? describe : describe.skip)(
  "signed duration literals, compiled",
  () => {
    it("evaluates to the negative (or explicitly positive) duration", () => {
      const result = compile(
        `PROGRAM Main
  VAR
    a : TIME := T#-14ms;
    b : TIME;
    c : TIME;
    d : LTIME := LTIME#-5m_30s;
    e : TIME;
    f : TIME;
    g : BOOL;
    h : TIME := T#+2s;
    k : DINT;
  END_VAR
  b := TIME#-1h2m;
  c := T#10s + T#-2.5s;
  e := -T#14ms;
  f := c - T#-1s;
  g := a = e AND T#-1ms < T#0ms;
  k := TIME_TO_DINT(T#-3s) ;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`,
        { headerFileName: "generated.hpp" },
      );
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "strucpp-signed-time-"),
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
  p.run();
  std::printf("%lld %lld %lld %lld %lld %lld %d %lld %d\\n", (long long)p.A, (long long)p.B,
              (long long)p.C, (long long)p.D, (long long)p.E, (long long)p.F, (int)p.G,
              (long long)p.H, (int)p.K);
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
          [
            "-14000000", // T#-14ms
            "-3720000000000", // TIME#-1h2m
            "7500000000", // T#10s + T#-2.5s
            "-330000000000", // LTIME#-5m_30s
            "-14000000", // -T#14ms
            "8500000000", // 7.5s - (-1s)
            "1",
            "2000000000", // T#+2s
            "-3000", // TIME_TO_DINT(T#-3s), milliseconds
          ].join(" "),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
