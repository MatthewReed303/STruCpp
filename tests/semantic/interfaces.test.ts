/**
 * Interfaces as variable types (IEC 61131-3 Ed.3 6.6.6): assignment and
 * comparison rules, the in-out ban, EXTENDS rules, the assignment attempt
 * `?=`, and method calls through interface variables and array elements.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const MOTORS = `
INTERFACE I_BASE
  METHOD Id : INT
  END_METHOD
END_INTERFACE
INTERFACE I_RUN EXTENDS I_BASE
  METHOD IsRunning : BOOL
  END_METHOD
END_INTERFACE
INTERFACE I_SPEED EXTENDS I_BASE
  METHOD Speed : REAL
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK M_DOL IMPLEMENTS I_RUN
  VAR_INPUT Cmd : BOOL; END_VAR
  METHOD PUBLIC Id : INT
    Id := 1;
  END_METHOD
  METHOD PUBLIC IsRunning : BOOL
    IsRunning := Cmd;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK M_VSD IMPLEMENTS I_RUN, I_SPEED
  VAR_INPUT Cmd : BOOL; SRef : REAL; END_VAR
  METHOD PUBLIC Id : INT
    Id := 2;
  END_METHOD
  METHOD PUBLIC IsRunning : BOOL
    IsRunning := Cmd AND SRef > 0.0;
  END_METHOD
  METHOD PUBLIC Speed : REAL
    Speed := SRef;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK PLAIN
  VAR_INPUT x : INT; END_VAR
END_FUNCTION_BLOCK
`;

function errorsOf(source: string): string[] {
  return compile(source).errors.map((e) => e.message);
}

describe("interface variables (6.6.6.5)", () => {
  it("accepts every value 6.6.6.5.1 lists and the comparisons it allows", () => {
    const result = compile(`${MOTORS}
FUNCTION_BLOCK PUMP
  VAR_INPUT Motor : I_RUN; END_VAR
  VAR_OUTPUT Run : BOOL; END_VAR
  IF Motor <> NULL THEN Run := Motor.IsRunning(); END_IF;
END_FUNCTION_BLOCK
PROGRAM Main
  VAR
    dol : M_DOL; vsd : M_VSD; p : PUMP;
    r : I_RUN := dol; r2 : I_RUN; b : I_BASE; s : I_SPEED;
    arr : ARRAY[1..2] OF I_RUN;
    same, isNull : BOOL; id : INT;
  END_VAR
  r2 := vsd;
  b := r;
  r := NULL;
  arr[1] := dol;
  same := r = r2;
  isNull := NULL = b;
  p(Motor := dol);
  p(Motor := arr[1]);
  id := arr[1].Id();
  s ?= b;
  s ?= vsd;
  s ?= NULL;
END_PROGRAM`);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.headerCode).toContain(
      "using I_RUN = IEC_IFACE_REF<I_RUN__IFACE>;",
    );
    expect(result.headerCode).toContain(
      "class I_RUN__IFACE : public virtual I_BASE__IFACE {",
    );
    expect(result.headerCode).toContain(
      "class M_VSD : public virtual I_RUN__IFACE, public virtual I_SPEED__IFACE {",
    );
    expect(result.cppCode).toContain("RUN = MOTOR->ISRUNNING();");
    expect(result.cppCode).toContain("ID = ARR.at(1)->ID();");
    expect(result.cppCode).toContain("S = I_SPEED::attempt(B.get());");
  });

  it("refuses an instance of a block that does not implement the interface", () => {
    expect(
      errorsOf(`${MOTORS}
PROGRAM Main
  VAR pl : PLAIN; r : I_RUN; END_VAR
  r := pl;
END_PROGRAM`).join("\n"),
    ).toMatch(/Cannot assign PLAIN to interface I_RUN.*6\.6\.6\.5\.1/);
  });

  it("refuses a base interface into a derived one, and a scalar", () => {
    const errors = errorsOf(`${MOTORS}
PROGRAM Main
  VAR b : I_BASE; r : I_RUN; i : INT; END_VAR
  r := b;
  r := i;
END_PROGRAM`);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Cannot assign I_BASE to interface I_RUN/);
  });

  it("refuses an interface into a block or scalar variable", () => {
    expect(
      errorsOf(`${MOTORS}
PROGRAM Main
  VAR r : I_RUN; d : M_DOL; END_VAR
  d := r;
END_PROGRAM`).join("\n"),
    ).toMatch(/Cannot assign interface I_RUN to M_DOL.*\?=/);
  });

  it("refuses ordering comparisons and comparisons across interfaces", () => {
    const errors = errorsOf(`${MOTORS}
PROGRAM Main
  VAR r : I_RUN; s : I_SPEED; x : BOOL; END_VAR
  x := r < r;
  x := r = s;
  x := r <> 0;
END_PROGRAM`);
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).toMatch(/6\.6\.6\.5\.1/);
  });

  it("refuses a wrong instance passed to an interface input", () => {
    expect(
      errorsOf(`${MOTORS}
FUNCTION_BLOCK PUMP
  VAR_INPUT Motor : I_RUN; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
  VAR pl : PLAIN; p : PUMP; END_VAR
  p(Motor := pl);
END_PROGRAM`).join("\n"),
    ).toMatch(/Cannot assign PLAIN to interface I_RUN/);
  });

  it("refuses a method the interface does not have", () => {
    expect(
      errorsOf(`${MOTORS}
PROGRAM Main
  VAR r : I_RUN; x : REAL; END_VAR
  x := r.Speed();
END_PROGRAM`).join("\n"),
    ).toMatch(/INTERFACE 'I_RUN' has no method 'SPEED'/);
  });
});

describe("where an interface may not be used", () => {
  it("refuses an interface as an in-out variable (6.6.6.2)", () => {
    expect(
      errorsOf(`${MOTORS}
FUNCTION_BLOCK PUMP
  VAR_IN_OUT Motor : I_RUN; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM`).join("\n"),
    ).toMatch(
      /VAR_IN_OUT 'MOTOR' cannot be of interface type 'I_RUN'.*6\.6\.6\.2/,
    );
  });

  it("accepts an array of interface references as an in-out (Array_Conform_Decl)", () => {
    expect(
      errorsOf(`${MOTORS}
FUNCTION_BLOCK STATION
  VAR_IN_OUT Motors : ARRAY[*] OF I_RUN; END_VAR
  VAR_OUTPUT n : INT; END_VAR
  IF Motors[LOWER_BOUND(Motors, 1)].IsRunning() THEN n := 1; END_IF;
END_FUNCTION_BLOCK
PROGRAM Main
  VAR st : STATION; arr : ARRAY[1..2] OF I_RUN; END_VAR
  st(Motors := arr);
END_PROGRAM`),
    ).toEqual([]);
  });

  it("refuses an interface-typed global (Annex A Global_Var_Decl)", () => {
    expect(
      errorsOf(`${MOTORS}
PROGRAM Main END_PROGRAM
CONFIGURATION Cfg
  VAR_GLOBAL g : I_RUN; END_VAR
  RESOURCE Res ON PLC
    TASK t(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM inst WITH t : Main;
  END_RESOURCE
END_CONFIGURATION`).join("\n"),
    ).toMatch(/VAR_GLOBAL 'G' cannot be of interface type 'I_RUN'/);
  });
});

describe("interface declarations (6.6.6.4, 6.6.6.6)", () => {
  it("requires the inherited prototypes too", () => {
    expect(
      errorsOf(`${MOTORS}
FUNCTION_BLOCK HALF IMPLEMENTS I_RUN
  METHOD IsRunning : BOOL
    IsRunning := TRUE;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM`).join("\n"),
    ).toMatch(/'HALF' implements 'I_RUN' but does not provide method 'ID'/);
  });

  it("refuses an implementation whose signature differs from the prototype", () => {
    expect(
      errorsOf(`${MOTORS}
FUNCTION_BLOCK BAD IMPLEMENTS I_BASE
  METHOD Id : DINT
    Id := 1;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM`).join("\n"),
    ).toMatch(
      /does not match its prototype in INTERFACE 'I_BASE'.*6\.6\.6\.4\.2/,
    );
  });

  it("refuses a recursive EXTENDS and a prototype repeated from a base", () => {
    const errors = errorsOf(`
INTERFACE A EXTENDS B
  METHOD M : BOOL
  END_METHOD
END_INTERFACE
INTERFACE B EXTENDS A
END_INTERFACE
INTERFACE C
  METHOD M : BOOL
  END_METHOD
END_INTERFACE
INTERFACE D EXTENDS C
  METHOD M : BOOL
  END_METHOD
END_INTERFACE
PROGRAM Main END_PROGRAM`).join("\n");
    expect(errors).toMatch(/'A' is its own base interface/);
    expect(errors).toMatch(
      /'D' declares method 'M', already a prototype of its base interface 'C'/,
    );
  });
});

describe("assignment attempt ?= (6.6.6.7)", () => {
  it("parses and refuses a non-interface target", () => {
    expect(
      errorsOf(`${MOTORS}
PROGRAM Main
  VAR d : M_DOL; x : INT; END_VAR
  x ?= d;
END_PROGRAM`).join("\n"),
    ).toMatch(
      /target of an assignment attempt \?= must be an interface variable/,
    );
  });

  it("queries the instance when the source's type is not known to implement it", () => {
    const result = compile(`${MOTORS}
PROGRAM Main
  VAR d : M_DOL; v : M_VSD; s : I_SPEED; pl : PLAIN; END_VAR
  s ?= d;
  s ?= v;
  s ?= pl;
END_PROGRAM`);
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("S = I_SPEED::attempt(&(D));");
    expect(result.cppCode).toContain("S = V;");
    expect(result.cppCode).toContain("S = IEC_NULL;");
  });
});
