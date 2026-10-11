// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Function block rules (IEC 61131-3 Ed.3): inheritance (6.6.5.5 - 6.6.5.10,
 * 6.6.7.2.5 - 6.6.7.2.11, 6.6.8.3), edge inputs (6.6.3.2 item 13, Annex A
 * Edge_Decl) and temporaries (6.5.2.1, 6.6.3.2 item 17, 6.6.7.2.3 rule 4).
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const messages = (source: string): { errors: string[]; warnings: string[] } => {
  const result = compile(source);
  return {
    errors: result.errors.map((e) => e.message),
    warnings: result.warnings.map((w) => w.message),
  };
};

/** [name, source, expected message part]. */
const REFUSED: Array<[string, string, string]> = [
  [
    "abstract_override",
    "FUNCTION_BLOCK ABSTRACT A METHOD PUBLIC M END_METHOD END_FUNCTION_BLOCK FUNCTION_BLOCK ABSTRACT D EXTENDS A METHOD PUBLIC ABSTRACT OVERRIDE M END_METHOD END_FUNCTION_BLOCK",
    "ABSTRACT shall not be used with OVERRIDE",
  ],
  [
    "abstract_unimpl",
    "FUNCTION_BLOCK ABSTRACT A METHOD PUBLIC ABSTRACT M END_METHOD END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS A END_FUNCTION_BLOCK",
    "does not implement ABSTRACT method",
  ],
  [
    "access_on_input",
    "FUNCTION_BLOCK F VAR_INPUT PUBLIC a : INT; END_VAR END_FUNCTION_BLOCK",
    "allowed only on a VAR section",
  ],
  [
    "dupvar",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B VAR x : INT; END_VAR END_FUNCTION_BLOCK",
    "shall be unique",
  ],
  [
    "edge_derived",
    "FUNCTION_BLOCK F VAR_INPUT a : BOOL R_EDGE; END_VAR VAR_OUTPUT q : BOOL; END_VAR q := a; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS F SUPER(); q := a; END_FUNCTION_BLOCK",
    "read it there",
  ],
  [
    "edge_function",
    "FUNCTION F : BOOL VAR_INPUT a : BOOL R_EDGE; END_VAR F := a; END_FUNCTION",
    "only a FUNCTION_BLOCK holds",
  ],
  [
    "edge_init",
    "FUNCTION_BLOCK F VAR_INPUT a : BOOL R_EDGE := TRUE; END_VAR END_FUNCTION_BLOCK",
    "takes no initial value",
  ],
  [
    "edge_method",
    "FUNCTION_BLOCK F VAR_INPUT a : BOOL R_EDGE; END_VAR VAR_OUTPUT q : BOOL; END_VAR METHOD PUBLIC M q := a; END_METHOD q := a; END_FUNCTION_BLOCK",
    "a method has no access to an edge input",
  ],
  [
    "edge_nonbool",
    "FUNCTION_BLOCK F VAR_INPUT a : INT R_EDGE; END_VAR END_FUNCTION_BLOCK",
    "BOOL input only",
  ],
  [
    "edge_output",
    "FUNCTION_BLOCK F VAR_OUTPUT a : BOOL R_EDGE; END_VAR END_FUNCTION_BLOCK",
    "qualifies an input only",
  ],
  [
    "iface_unimpl",
    "INTERFACE I METHOD K : INT END_METHOD END_INTERFACE FUNCTION_BLOCK ABSTRACT A IMPLEMENTS I END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS A END_FUNCTION_BLOCK",
    "which it inherits",
  ],
  [
    "inout_extra",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B VAR_IN_OUT c : INT; END_VAR SUPER(); END_FUNCTION_BLOCK FUNCTION_BLOCK R VAR_IN_OUT i : B; END_VAR i(a := 1); END_FUNCTION_BLOCK PROGRAM P VAR d : D; r : R; END_VAR r(i := d); END_PROGRAM",
    "additional in-out",
  ],
  [
    "method_is_var",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B METHOD PUBLIC q END_METHOD END_FUNCTION_BLOCK",
    "6.6.5.5.5 rule 2",
  ],
  [
    "override_private",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B METHOD PRIVATE OVERRIDE PM END_METHOD END_FUNCTION_BLOCK",
    "is PRIVATE and not inherited",
  ],
  [
    "private_method_derived",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B THIS.PM(); END_FUNCTION_BLOCK",
    "Cannot call PRIVATE method",
  ],
  [
    "private_var_derived",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B p2 := 0; x := p; END_FUNCTION_BLOCK",
    "PRIVATE variable of 'B'",
  ],
  [
    "private_var_outside",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK PROGRAM P VAR b : B; v : INT; END_VAR v := b.p; END_PROGRAM",
    "PRIVATE variable of 'B'",
  ],
  [
    "protected_method_outside",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK PROGRAM P VAR d : B; END_VAR d.QM(); END_PROGRAM",
    "Cannot call PROTECTED method",
  ],
  [
    "protected_var_outside",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK PROGRAM P VAR b : B; v : INT; END_VAR v := b.q; END_PROGRAM",
    "PROTECTED variable of 'B'",
  ],
  [
    "super_args",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B SUPER(a := 1); END_FUNCTION_BLOCK",
    "has no parameters",
  ],
  [
    "super_loop",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B VAR i : INT; END_VAR FOR i := 1 TO 2 DO SUPER(); END_FOR; END_FUNCTION_BLOCK",
    "shall not be in a loop",
  ],
  [
    "super_method",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B METHOD PUBLIC Z SUPER(); END_METHOD SUPER(); END_FUNCTION_BLOCK",
    "not in a method",
  ],
  [
    "super_nobase",
    "FUNCTION_BLOCK D VAR x : INT; END_VAR SUPER(); END_FUNCTION_BLOCK",
    "does not EXTEND",
  ],
  [
    "super_prog",
    "PROGRAM P VAR x : INT; END_VAR SUPER(); END_PROGRAM",
    "only in the body of a derived",
  ],
  [
    "super_twice",
    "FUNCTION_BLOCK B VAR_INPUT a : INT; END_VAR VAR_OUTPUT x : INT; END_VAR VAR PRIVATE p : INT; END_VAR VAR PROTECTED q : INT; END_VAR METHOD PUBLIC M : INT M := 1; END_METHOD METHOD PRIVATE PM END_METHOD METHOD PROTECTED QM END_METHOD x := a + 1; END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS B SUPER(); SUPER(); END_FUNCTION_BLOCK",
    "shall occur once",
  ],
  [
    "temp_fb",
    "FUNCTION_BLOCK G VAR_OUTPUT q : BOOL; END_VAR END_FUNCTION_BLOCK FUNCTION_BLOCK F VAR_TEMP t : G; END_VAR END_FUNCTION_BLOCK",
    "cannot be declared in VAR_TEMP",
  ],
  [
    "temp_method",
    "FUNCTION_BLOCK F VAR_TEMP t : INT; END_VAR VAR_OUTPUT q : INT; END_VAR METHOD PUBLIC M q := t; END_METHOD END_FUNCTION_BLOCK",
    "not available in a method",
  ],
  [
    "temp_outside",
    "FUNCTION_BLOCK F VAR_TEMP t : INT; END_VAR END_FUNCTION_BLOCK PROGRAM P VAR f : F; v : INT; END_VAR v := f.t; END_PROGRAM",
    "cannot be reached from outside",
  ],
];

describe("function block rules: refused", () => {
  for (const [name, source, expected] of REFUSED) {
    it(name, () => {
      const { errors } = messages(source);
      expect(errors.some((m) => m.includes(expected))).toBe(true);
    });
  }
});

const BASE = `FUNCTION_BLOCK B
  VAR_INPUT a : INT; END_VAR
  VAR_OUTPUT x : INT; END_VAR
  METHOD PUBLIC M : INT
    M := 1;
  END_METHOD
  x := a + 1;
END_FUNCTION_BLOCK`;

describe("function block rules: warned (CODESYS overrides without OVERRIDE)", () => {
  it("an overriding method without OVERRIDE", () => {
    const { errors, warnings } = messages(
      `${BASE} FUNCTION_BLOCK D EXTENDS B METHOD PUBLIC M : INT M := 2; END_METHOD END_FUNCTION_BLOCK`,
    );
    expect(errors).toEqual([]);
    expect(warnings.some((m) => m.includes("requires METHOD OVERRIDE"))).toBe(true);
  });

  it("an overriding method with another access specifier", () => {
    const { warnings } = messages(
      `${BASE} FUNCTION_BLOCK D EXTENDS B METHOD PROTECTED OVERRIDE M : INT M := 2; END_METHOD END_FUNCTION_BLOCK`,
    );
    expect(warnings.some((m) => m.includes("same access specifier"))).toBe(true);
  });
});

describe("function block rules: accepted", () => {
  it("IEC forms: SUPER(), SUPER.m(), THIS, VAR PROTECTED from a derived block", () => {
    const { errors, warnings } = messages(`
INTERFACE I_ROOM
  METHOD DAYTIME END_METHOD
END_INTERFACE
FUNCTION_BLOCK CTRL
  VAR_INPUT RM : I_ROOM; END_VAR
  IF RM <> NULL THEN RM.DAYTIME(); END_IF;
END_FUNCTION_BLOCK
FUNCTION_BLOCK ROOM IMPLEMENTS I_ROOM
  VAR_INPUT a : INT; Go : BOOL R_EDGE; END_VAR
  VAR_OUTPUT x : INT; END_VAR
  VAR PROTECTED level : INT; END_VAR
  VAR PUBLIC light : BOOL; END_VAR
  METHOD PUBLIC DAYTIME light := FALSE; END_METHOD
  METHOD PROTECTED Dim level := level - 1; END_METHOD
  IF Go THEN x := a + 1; END_IF;
END_FUNCTION_BLOCK
FUNCTION_BLOCK ROOM2 EXTENDS ROOM IMPLEMENTS I_ROOM
  VAR c : CTRL; END_VAR
  METHOD PUBLIC OVERRIDE DAYTIME
    SUPER.DAYTIME();
    level := level + 1;
    THIS.Dim();
  END_METHOD
  SUPER();
  c(RM := THIS);
END_FUNCTION_BLOCK
FUNCTION_BLOCK ABSTRACT SHAPE
  VAR_OUTPUT area : REAL; END_VAR
  METHOD PUBLIC ABSTRACT Calc : REAL END_METHOD
  area := THIS.Calc();
END_FUNCTION_BLOCK
FUNCTION_BLOCK SQUARE EXTENDS SHAPE
  VAR_INPUT side : REAL; END_VAR
  METHOD PUBLIC Calc : REAL Calc := side * side; END_METHOD
  SUPER();
END_FUNCTION_BLOCK
FUNCTION_BLOCK USER
  VAR_IN_OUT s : SHAPE; END_VAR
  s();
END_FUNCTION_BLOCK
PROGRAM P
  VAR r : ROOM2; q : SQUARE; u : USER; v : BOOL; END_VAR
  r(a := 1, Go := TRUE);
  v := r.light;
  v := r.Go;
  u(s := q);
END_PROGRAM`);
    expect(errors).toEqual([]);
    expect(warnings.filter((m) => m.includes("OVERRIDE"))).toEqual([]);
  });

  it("R_EDGE and F_EDGE stay usable as names (OSCAT declares them)", () => {
    const { errors } = messages(`
FUNCTION_BLOCK F
  VAR_INPUT RST : BOOL; END_VAR
  VAR R_EDGE : BOOL; F_EDGE : BOOL; END_VAR
  R_EDGE := RST;
  F_EDGE := NOT R_EDGE;
END_FUNCTION_BLOCK`);
    expect(errors).toEqual([]);
  });
});
