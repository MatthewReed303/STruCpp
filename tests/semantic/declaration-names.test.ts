// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Autonomy / OpenPLC Project
/**
 * Names of declared elements (IEC 61131-3 Ed.3):
 *
 * - a keyword, elementary type names included (6.1.3, Table 10), cannot name a
 *   variable, pin, structure element, enumerated value, data type or POU;
 * - identifiers are case-insensitive (6.1.2), so two elements of one scope
 *   differing only in letter case are the same name;
 * - a method and a variable of one function block share that block's member
 *   names (6.6.5.4.3 rule 10, 6.6.5.5.5 rules 1 and 2).
 *
 * Standard function and function block names are not keywords (Annex A
 * `Std_Func_Name`, `Std_FB_Name`): LIMIT or SET stay legal variable names.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const errorsOf = (source: string): string[] =>
  compile(source).errors.map((e) => e.message);

const ACCEPTED: Array<[string, string]> = [
  [
    "standard function names as variables",
    "PROGRAM P VAR LIMIT : INT; SET : BOOL; GET : BOOL; MAX : INT; END_VAR LIMIT := 1; END_PROGRAM",
  ],
  [
    "a keyword inside a longer name",
    "PROGRAM P VAR time_on : TIME; WordCount : INT; IntValue : INT; END_VAR time_on := T#1s; END_PROGRAM",
  ],
  [
    "the same local name in two methods",
    "FUNCTION_BLOCK F METHOD PUBLIC A VAR k : INT; END_VAR k := 1; END_METHOD METHOD PUBLIC B VAR k : INT; END_VAR k := 2; END_METHOD END_FUNCTION_BLOCK",
  ],
  [
    "a struct field named like a field of another struct",
    "TYPE S1 : STRUCT a : INT; END_STRUCT; END_TYPE TYPE S2 : STRUCT a : INT; END_STRUCT; END_TYPE",
  ],
  [
    "an enumerated value reused by another enumeration",
    "TYPE E1 : (red, green); END_TYPE TYPE E2 : (red, blue); END_TYPE",
  ],
  [
    "OSCAT's STEP and r_edge variables (SFC keyword, edge qualifier)",
    "FUNCTION_BLOCK F VAR_INPUT STEP : BYTE; END_VAR VAR r_edge : BOOL; END_VAR r_edge := STEP > 0; END_FUNCTION_BLOCK",
  ],
];

/** [name, source, expected message part]. */
const REFUSED: Array<[string, string, RegExp]> = [
  [
    "an elementary type name as a struct field",
    "TYPE S : STRUCT time : TIME; END_STRUCT; END_TYPE",
    /'time' is a keyword/i,
  ],
  [
    "an elementary type name as a variable",
    "PROGRAM P VAR Word : WORD; END_VAR Word := 1; END_PROGRAM",
    /'Word' is a keyword/i,
  ],
  [
    "an elementary type name as a pin",
    "FUNCTION_BLOCK F VAR_INPUT Int : INT; END_VAR END_FUNCTION_BLOCK",
    /'Int' is a keyword/i,
  ],
  [
    "an elementary type name as an output of a function",
    "FUNCTION F : INT VAR_OUTPUT dt : DT; END_VAR F := 1; END_FUNCTION",
    /'dt' is a keyword/i,
  ],
  [
    "a keyword as a method local",
    "FUNCTION_BLOCK F METHOD PUBLIC M VAR string : STRING; END_VAR END_METHOD END_FUNCTION_BLOCK",
    /'string' is a keyword/i,
  ],
  [
    "a keyword as a function block name",
    "FUNCTION_BLOCK Real END_FUNCTION_BLOCK",
    /'Real' is a keyword/i,
  ],
  [
    "a keyword as a function name",
    "FUNCTION Byte : INT Byte := 1; END_FUNCTION",
    /'Byte' is a keyword/i,
  ],
  [
    "a keyword as a method name",
    "FUNCTION_BLOCK F METHOD PUBLIC Date : INT Date := 1; END_METHOD END_FUNCTION_BLOCK",
    /'Date' is a keyword/i,
  ],
  [
    "a keyword as an enumerated value",
    "TYPE E : (Off, Tod); END_TYPE",
    /'Tod' is a keyword/i,
  ],
  [
    "a keyword as a global variable",
    "VAR_GLOBAL lword : LWORD; END_VAR PROGRAM P END_PROGRAM",
    // the global scope already holds the type name
    /'lword' is a keyword|'LWORD' already defined/i,
  ],
  [
    "a non-tokenised IEC keyword as a variable",
    "PROGRAM P VAR namespace : INT; END_VAR namespace := 1; END_PROGRAM",
    /'namespace' is a keyword/i,
  ],
  [
    "a variable named like a method of its block",
    "FUNCTION_BLOCK F VAR Ready : BOOL; END_VAR METHOD PUBLIC ready : BOOL ready := TRUE; END_METHOD END_FUNCTION_BLOCK",
    /'Ready'.*method/i,
  ],
  [
    "an output named like a method of its block",
    "FUNCTION_BLOCK F VAR_OUTPUT Done : BOOL; END_VAR METHOD PUBLIC Done : BOOL Done := TRUE; END_METHOD END_FUNCTION_BLOCK",
    /'Done'.*method/i,
  ],
  [
    "two methods whose names differ in case",
    "FUNCTION_BLOCK F METHOD PUBLIC m1 END_METHOD METHOD PUBLIC M1 END_METHOD END_FUNCTION_BLOCK",
    /'M1'.*already/i,
  ],
  [
    "two struct fields whose names differ in case",
    "TYPE S : STRUCT a : INT; A : INT; END_STRUCT; END_TYPE",
    /'A'.*already/i,
  ],
  [
    "two enumerated values whose names differ in case",
    "TYPE E : (red, RED); END_TYPE",
    /'RED'.*already/i,
  ],
  [
    "locals differing in case",
    "PROGRAM P VAR kk : INT; kK : INT; END_VAR kk := 1; END_PROGRAM",
    /already defined/i,
  ],
  [
    "a local and a pin differing in case",
    "FUNCTION_BLOCK F VAR_INPUT ok : BOOL; END_VAR VAR Ok : BOOL; END_VAR END_FUNCTION_BLOCK",
    /already defined/i,
  ],
  [
    "a method local and a method pin differing in case",
    "FUNCTION_BLOCK F METHOD PUBLIC M VAR_INPUT ok : BOOL; END_VAR VAR Ok : BOOL; END_VAR END_METHOD END_FUNCTION_BLOCK",
    /already defined/i,
  ],
];

describe("declared names (IEC 61131-3 6.1.2, 6.1.3, 6.6.5.5.5)", () => {
  for (const [name, source] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      expect(errorsOf(source)).toEqual([]);
    });
  }
  for (const [name, source, message] of REFUSED) {
    it(`refuses ${name}`, () => {
      expect(errorsOf(source).join("\n")).toMatch(message);
    });
  }
});
