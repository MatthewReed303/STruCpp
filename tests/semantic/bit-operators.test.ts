// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * The bitwise Boolean operators AND (&), OR, XOR and NOT are defined for
 * ANY_BIT only (IEC 61131-3 Ed.3 Table 31; Table 71 lists them as the ST
 * operators). An integer, real or time operand is an error; an integer
 * literal without a type prefix is a bit-string literal there (6.3.2,
 * Table 5).
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const errorsOf = (body: string): string[] =>
  compile(
    `PROGRAM P
VAR u : USINT; b : BOOL; w : WORD; bt : BYTE; i : INT; r : REAL; t : TIME; END_VAR
${body}
END_PROGRAM`,
  ).errors.map((e) => e.message);

const ACCEPTED: Array<[string, string]> = [
  ["NOT BOOL", "b := NOT b;"],
  ["NOT WORD", "w := NOT w;"],
  ["NOT BYTE", "bt := NOT bt;"],
  ["BOOL AND BOOL", "b := b AND b;"],
  ["BOOL & BOOL", "b := b & b;"],
  ["comparison XOR BOOL", "b := r > 1.0 XOR b;"],
  ["WORD AND literal", "w := w AND 16#FF;"],
  ["literal OR WORD", "w := 16#0F OR w;"],
  ["BYTE XOR BYTE", "bt := bt XOR bt;"],
  ["NOT of a comparison", "b := NOT (i > 3);"],
  ["NOT of a bit", "b := NOT w.3;"],
  // the untyped literal takes the BYTE type of the sum (OSCAT MATRIX)
  ["BYTE sum AND literal", "bt := (bt + 1) AND 2#0000_0011;"],
  // OSCAT REVERSE
  ["rotations AND literals", "bt := ROR(bt, 1) AND 2#10001000 OR ROL(bt, 1) AND 2#00010001;"],
];

const REFUSED: Array<[string, string]> = [
  ["NOT USINT", "u := NOT u;"],
  ["NOT INT", "i := NOT i;"],
  ["NOT REAL", "r := NOT r;"],
  ["INT AND literal", "i := i AND 3;"],
  ["USINT OR USINT", "u := u OR u;"],
  ["XOR on INT and WORD", "w := w XOR i;"],
  ["& on TIME", "t := t & t;"],
];

describe("bitwise operators take ANY_BIT operands (IEC 61131-3 Table 31)", () => {
  for (const [name, body] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      expect(errorsOf(body)).toEqual([]);
    });
  }
  for (const [name, body] of REFUSED) {
    it(`refuses ${name}`, () => {
      const errors = errorsOf(body);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(/ANY_BIT/);
    });
  }
});
