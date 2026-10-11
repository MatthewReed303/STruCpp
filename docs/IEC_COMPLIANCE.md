# IEC 61131-3 Compliance

STruC++ implements the Structured Text (ST) language from IEC 61131-3. This document lists supported features and known gaps. The compiler also supports common CODESYS extensions where noted.

## Data Types

| Type | Status | Notes |
|------|--------|-------|
| BOOL | Supported | |
| BYTE, WORD, DWORD, LWORD | Supported | |
| SINT, INT, DINT, LINT | Supported | |
| USINT, UINT, UDINT, ULINT | Supported | |
| REAL, LREAL | Supported | |
| TIME | Supported | Nanosecond precision, int64_t storage |
| DATE | Supported | |
| TIME_OF_DAY | Supported | |
| DATE_AND_TIME | Supported | |
| LTIME, LTOD, LDT | Supported | 64-bit nanoseconds, sharing TIME/TOD/DT storage. Literals `LT#`, `LTIME#`, `LTOD#`, `LDT#`; implicit TIME→LTIME, TOD→LTOD, DT→LDT |
| LDATE | Not implemented | Needs nanoseconds; DATE stores whole days, so it cannot share DATE's representation |
| STRING | Supported | Parameterized length: STRING(N), default 254 |
| WSTRING | Supported | Parameterized length: WSTRING(N) |
| CHAR, WCHAR | Supported | |

### Derived Types

| Type | Status | Notes |
|------|--------|-------|
| TYPE ... END_TYPE | Supported | Type aliases |
| STRUCT ... END_STRUCT | Supported | With nested structs. An access path naming an element its type does not declare (`s.nosuch`, `arr[1].inner.nosuch`, `fb.nosuch`) is an error at the ST line (§6.4.4.6.1; Table 41 features 6a, 7) — for structures, local or from a library manifest, and user function blocks. A library block's members are not judged: its manifest omits what it inherits, its methods and its properties |
| Enumerations | Supported | §6.4.4.2, Table 11 feature 1: stored as INT. Compared only with a value of its own type; Table 38 admits SEL, MUX, EQ and NE, and a value of one is not converted to or from an integer in an assignment or a parameter (§6.6.1.6, Figure 11). `TO_*` yields its number. `<`, `>`, `<=` and `>=` between two values of one enumeration also compile, outside Table 38 |
| Data types with named values | Supported | §6.4.4.3, Table 11 feature 2: `T : USINT (A := 0, B := 1) := B`. The base is an integer or bit-string type, and stored at its width; every value must fit it. Its values are values of the base type: a constant or calculation may be assigned (`x := 27`, `x := A + 1`), they compare and compute as the base, and convert implicitly as the base does (Figure 12) in assignments and input/output parameters, not in-outs. Standard functions other than SEL, MUX, EQ and NE (`ADD`, `MAX`, `LIMIT`, …) do not take one |
| One declaration per type name | Supported | A `TYPE` name declared twice in one compilation (one file or several) is an error at the second declaration (§6.4.4.1.1, §6.9.1: one name, one element of the global namespace). A project type of the same name as a library type replaces the library's |
| Initialized type declarations | Supported | A type may carry its own default (`Setpoint : REAL := 25.0;`, `Origin : Point := (x := 0.0);`), inherited by every declaration of the type that has no initializer |
| ARRAY (1D) | Supported | Arbitrary bounds: ARRAY[1..10] OF INT |
| ARRAY (2D) | Supported | ARRAY[1..3, 1..4] OF REAL |
| ARRAY (3D) | Supported | ARRAY[1..3, 1..4, 1..5] OF INT |
| ARRAY OF function block | Supported | Declaration, member access, and element invocation (`units[i](step := 1.0)`). A *method* call on an element (`units[0].M()`) is not yet parsed |
| ARRAY[*] (VLA) | Supported | Variable-length array parameters |
| Subranges | Supported | Runtime validation |
| REF_TO | Supported | IEC reference type (explicit dereference) |
| REFERENCE_TO | Supported | CODESYS reference type (implicit dereference) |
| POINTER TO | Supported | CODESYS pointer type with dereference via ^ |

### Not Implemented

| Type | Notes |
|------|-------|
| UNION | CODESYS extension |

## Program Organization Units

| POU | Status | Notes |
|-----|--------|-------|
| PROGRAM | Supported | With CONFIGURATION/RESOURCE/TASK structure |
| FUNCTION | Supported | With return type, all parameter modes |
| FUNCTION_BLOCK | Supported | Instantiation, invocation, member access |
| INTERFACE | Supported | Method prototypes, EXTENDS, interface variables, `?=` — see [Interfaces](#interfaces-666). `PROPERTY` in an INTERFACE (CODESYS) is not supported |

## Variable Declarations

| Feature | Status | Notes |
|---------|--------|-------|
| VAR | Supported | Local variables |
| VAR_INPUT | Supported | Input parameters |
| VAR_OUTPUT | Supported | Output parameters |
| VAR_TEMP | Supported | Created and initialised (declared initial value, else the type default) at each call (§6.5.2.1). In a `FUNCTION_BLOCK` it is a local of the body, not part of the instance: it does not keep its value between calls, is not in the debug map, and cannot be reached from outside (`inst.t`), from a method (§6.6.7.2.3 rule 4) or from a derived block. A function block instance in `VAR_TEMP` is refused (§6.6.3.2 item 17). A temporary lives on the task's stack, so a large array there needs stack room on a board. Earlier versions kept a block's `VAR_TEMP` per instance; a program that relied on that now sees the IEC behaviour. In a `PROGRAM` the same: a local of `run()`, initialised at each call, not in the debug map |
| Edge inputs `BOOL R_EDGE` / `BOOL F_EDGE` | Supported | On a `FUNCTION_BLOCK` `VAR_INPUT` (§6.6.3.2 item 13, Annex A `Edge_Decl`, Table 40 feature 6). The body sees the output Q of an implicit R_TRIG / F_TRIG on the input (Table 44); the caller's value stays readable as the input. The edge memory is one hidden `bool` per input, FALSE at every start (cold or warm; it is not retained): an `R_EDGE` input already TRUE at the first call is an edge, and so is an `F_EDGE` input already FALSE (Table 44 NOTE). Refused: on another type or section, with an initial value, on a `FUNCTION`, `METHOD` or interface prototype (no instance holds the trigger), read in a method (§6.6.7.2.3 rule 3), and read in a derived block's body (the edge is detected in the declaring block's body, which a derived block runs with `SUPER()`; IEC does not say what a derived body reads, so it is refused rather than guessed). `R_EDGE` / `F_EDGE` stay usable as variable names. On a `PROGRAM` (Table 47 feature 6a): not implemented, refused |
| Access specifier on `VAR` | Supported | `VAR PUBLIC` / `PROTECTED` / `PRIVATE` in a `FUNCTION_BLOCK` (§6.6.5.10, §6.6.7.2.6), enforced for access from outside and from derived blocks. A `VAR` with no specifier keeps this compiler's earlier behaviour (readable and writable from outside), not IEC's default `PROTECTED`. `INTERNAL` (namespaces) is not implemented. Refused on any other section (§6.6.7.2.6) |
| VAR_IN_OUT | Supported | In-out parameters — see below |
| VAR_EXTERNAL | Supported | References either a CONFIGURATION or a file-level VAR_GLOBAL |
| VAR_GLOBAL | Supported | Global variables (CONFIGURATION-scoped or file-level) |
| CONSTANT | Supported | Compile-time constants |
| RETAIN | Supported | Allowed on `VAR`, `VAR_INPUT`, `VAR_OUTPUT` and `VAR_GLOBAL`, per IEC 61131-3. Rejected on `VAR_IN_OUT` / `VAR_TEMP` / `VAR_EXTERNAL`, and inside a `FUNCTION` or `METHOD` (no instance, nothing to retain) |
| PERSISTENT | Partial | Accepted and treated as `RETAIN`. CODESYS also keeps a PERSISTENT value across a program download; that is not implemented, so the weaker shared guarantee is what is claimed |
| NON_RETAIN | Supported | Accepted and treated as the default (a plain `VAR` is already non-retained). Rejected when combined with `RETAIN` or `CONSTANT`. A `VAR` / `VAR_INPUT` / `VAR_OUTPUT NON_RETAIN` member of a function block stays out of an instance declared `RETAIN` (§6.5.6.2), for a library block too (its manifest marks the member `nonRetain`) |
| Retained values across an upload | Supported | An upload is a warm restart (§6.5.6.1 rule 1): every retained variable that still exists, by name, gets its value back. An element of an array of structures or blocks is named by its own subscript and member, so a resized array (`ARRAY [1..4] OF ZONE` -> `[1..5]` or `[1..3]`) keeps every element whose subscript still exists; new elements start from their initial values (§6.5.6.2), removed ones are dropped. A retained value of an enumerated or named-value type (§6.4.4.2, §6.4.4.3) is kept when the type's old member list is the START of the new one (same names, order and values; members only appended — decision 26); any other change of the type (reorder, rename, removal, a changed value or base) drops it and the variable starts from its initial value. A changed subrange drops it too |
| AT %IX0.0 | Supported | Located variables (I/Q/M areas, X/B/W/D/L sizes) |
| Multiple names | Supported | `a, b, c : INT := 0;` |
| Initialization | Supported | `:= expression` |
| Array initialization | Supported | `:= [1, 2, 3]` and the bracket-less `:= 1, 2, 3`. Multi-dimensional arrays take either a flat row-major list or a nested one (`:= [[1, 2], [3, 4]]`), where each inner list fills one row from its own bound. Nesting depth and value count are validated against the declared dimensions |
| Array repetition | Supported | `:= [10(0)]`, `:= [3(1), 2(5)]`, `:= [7, 4(2), 9]`. The repeated value may be a structure initializer. Max count 65536 |
| Structure initialization | Supported | `:= (x := 1.0, y := 2.0)`; nested, in array literals, and for FB instances. Omitted elements keep their own declared default. Only valid as a declaration's initial value, as in the standard — one written inside a statement is rejected. An element the structure does not have (e.g. a member of a nested structure named at the outer level) is an error at its ST position (§6.4.4.6.2); not checked for a function block's initial inputs |
| STRUCT element defaults | Supported | Scalar, array-literal and structure-initializer defaults on a STRUCT element all carry their values |

### VAR_IN_OUT rules

| Rule | Notes |
|------|-------|
| Assigned at every call | An in-out left unassigned is an error, including on a later call to an instance an earlier call assigned |
| Argument is a variable | A literal or an expression result is refused. An array element, a struct field or the calling POU's own in-out are accepted — the root of the access chain is what is checked |
| Argument is writable | Must be a non-`CONSTANT` variable from `VAR`, `VAR_TEMP`, `VAR_OUTPUT`, `VAR_IN_OUT` or `VAR_EXTERNAL` of the calling POU. The caller's own `VAR_INPUT` is refused |
| No implicit conversion | The argument's type must match the parameter's. Checked for a whole elementary variable; an element or field is left to C++ |
| Unnamed arguments allowed | They fill the slots the named ones did not claim, in declaration order |
| Used only in the body and the call | `inst.someInOut` is refused for read and write, as is capturing one with `=>` |
| Out of reach from a method | A method cannot use the in-outs of the block that owns it; it may declare its own |
| No qualifier | `CONSTANT`, `RETAIN` and `NON_RETAIN` are refused |
| No initial value | `:= value` on an in-out declaration is refused |
| Not a reference type | `REF_TO` / `REFERENCE TO` is refused. Not enforced for an interface imported from a library |
| Passing mechanism | The in-out IS the caller's variable (§3.48). A function takes its in-outs as C++ references. A function block binds each in-out by reference, once, before the call — a function block instance, an `ARRAY [*]`, and a scalar, structure, string or fixed-bound array named by a variable, element or field — so its body reads and writes the caller's storage. Copied in and back instead: a bit or partial access (`w.3`, `w.%B1`), a shared global (copied under its lock), an actual of another declared type (a `STRING(10)` for a `STRING`), and a block from a library archive built before by-reference binding (a warning names it; rebuild the archive) |
| Debugging an in-out | An opened instance shows each value in-out as a live, read-only view of the bound variable (`indirect` in debug-map.json, with `target` naming that variable when every call binds the same one). It is forced at the variable's own name; the runtime refuses a force or write at the view. A function block in-out and an `ARRAY [*]` in-out (a view whose length is known only at the call) get no entry of their own: they are aliases, debugged at the caller's variable, and the build lists them as not debuggable for that reason |
| RETAIN instance | A `RETAIN` instance does not retain its in-outs (§6.5.6: no `RETAIN` on `VAR_IN_OUT`): what they show belongs to the caller. A warning says so |
| Function block instance | On `VAR_INPUT` read-only and not callable; on `VAR_IN_OUT` read, written and callable, held as a pointer with no copy back; on `VAR_EXTERNAL` callable. Its outputs are readable but not writable in all three |

### Initialization gaps

| Form | Notes |
|------|-------|
| Repetition with no value | `:= [10()]` (ten copies of the element default) — write `:= [10(0)]`, or omit the elements entirely. Matches matiec and CODESYS, which also require a value |

## Operators and Expressions

| Category | Operators | Status |
|----------|-----------|--------|
| Arithmetic | `+`, `-`, `*`, `/`, `MOD`, `**` | Supported |
| Comparison | `=`, `<>`, `<`, `>`, `<=`, `>=` | Supported |
| Logical | `AND`, `OR`, `XOR`, `NOT` | Supported |
| Bitwise | `AND`, `OR`, `XOR`, `NOT` (on bit types) | Supported |
| Bit shift | `SHL`, `SHR`, `ROL`, `ROR` | Supported |
| Assignment | `:=` | Supported |
| Reference assign | `REF=` | Supported |
| Dereference | `^`, `DREF()` | Supported |
| Reference | `REF()` | Supported |
| Parentheses | `( )` | Supported |
| Function call | `name(args)` | Supported (positional + named). A formal call maps its arguments by name in any order, and an omitted input takes its declared initial value (§6.6.1.4.2), for a library function too; a `VAR_OUTPUT` is written back with `=>` (§6.6.2.2) |
| Method call | `obj.method(args)` | Supported |
| Array access | `arr[i]`, `arr[i, j]` | Supported — the index count is validated against the declared rank |
| Field access | `struct.field` | Supported |
| Partial access | `var.0`, `var.%X0`, `var.%B1`, `var.%W0`, `var.%D1` | Supported — read and write. Also accepted on the integer types, which warns, as CODESYS's SA0148 does |
| Typed literals | `INT#5`, `DINT#42`, `REAL#3.14` | Supported |
| Integer literals | `9223372036854775807`, `16#FF`, `1_000` | Supported — the full 64-bit LINT/ULINT range is preserved exactly; a value wider than ULINT is rejected |
| Duration literals | `T#14ms`, `TIME#1h_2m`, `LT#14.7s`, `T#-14ms`, `TIME#+2s` | Supported — a sign after the prefix applies to the whole duration (Table 8); `-T#14ms` is the same value |
| NEW | `__NEW(type)`, `__NEW(type, size)` | Supported |
| DELETE | `__DELETE(ptr)` | Supported |

## Control Structures

| Structure | Status | Notes |
|-----------|--------|-------|
| IF / ELSIF / ELSE / END_IF | Supported | |
| FOR / TO / BY / DO / END_FOR | Supported | With optional BY (step) |
| WHILE / DO / END_WHILE | Supported | |
| REPEAT / UNTIL / END_REPEAT | Supported | |
| CASE / OF / END_CASE | Supported | Integer, bit, and enum selectors |
| EXIT | Supported | Break from loop |
| RETURN | Supported | Early return from POU |

## OOP Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Methods | Supported | On FUNCTION_BLOCK, with return types. A method without an access specifier is `PUBLIC` (CODESYS), not IEC's default `PROTECTED`. A variable may share a method's name (own, inherited or of an implemented interface); its C++ member is renamed |
| Properties (GET/SET) | Supported | Virtual getter/setter methods in C++ |
| Inheritance (EXTENDS) | Supported | Single inheritance — see [Function block inheritance](#function-block-inheritance-66727-11) |
| Interfaces (IMPLEMENTS) | Supported | Multiple interfaces, generates C++ abstract classes — see [Interfaces](#interfaces-666) |
| ABSTRACT | Supported | Abstract FB (no instantiation) and abstract methods (pure virtual). An abstract FB need not hold an abstract method (§6.6.7.5 leaves FBs to the implementer). An abstract type is accepted as an in-out (§6.6.5.8.2); as a `VAR_INPUT` it is refused (an input holds a copy) |
| FINAL | Supported | Sealed FB and methods |
| OVERRIDE | Supported | Method override with C++ override specifier |
| PUBLIC/PRIVATE/PROTECTED | Supported | On methods and on `VAR` sections |
| THIS | Supported | `THIS.m()`, `THIS.v`, and a bare `THIS` (the own instance, e.g. passed to an interface input, §6.6.5.7.2); CODESYS `THIS^` too |

### Function block inheritance (6.6.7.2.7-11)

| Rule | Notes |
|------|-------|
| Body (6.6.7.2.9) | Not inherited: a derived block runs its own body, and the base body only where it calls `SUPER()` (IEC form; CODESYS `SUPER^()` too). `SUPER()` has no parameters, occurs once in the body, not in a loop, and not in a method; it needs an EXTENDS |
| Dynamic binding (6.6.7.2.9 rule 4, 6.6.8.3) | The call of a block is bound dynamically: an instance of a derived block passed to an in-out of its base type runs the derived body. Every block that is not `FINAL`, or that EXTENDS another, has a virtual body (it already had a virtual destructor, so an instance does not grow) |
| In-out polymorphism (6.6.8.3) | An in-out of block type T takes an instance of T or of a block derived from T that adds no in-out; anything else is refused |
| Names (6.6.7.2.9 rule 3, 6.6.5.5.5 rule 2) | A derived block's variable may not repeat a base variable's name, nor its method a base variable's name |
| OVERRIDE (6.6.5.5.3, 6.6.7.2.10) | A method replacing an inherited one with the same signature. Without `OVERRIDE`, or with another access specifier, it still builds with a **warning** (CODESYS overrides without the keyword); implementing an inherited `ABSTRACT` method needs no `OVERRIDE`. `ABSTRACT OVERRIDE` is refused (6.6.5.8.3). A `PRIVATE` method is not inherited (6.6.5.5.2 rule 1): `OVERRIDE` of it is refused |
| ABSTRACT completeness (6.6.5.8.2, 6.6.5.8.3) | A non-abstract block implements every inherited `ABSTRACT` method and every prototype of an interface a base implements |
| SUPER.m() (6.6.5.7.3) | Static call of the base's method, in the body or a method of a derived block |
| Access (6.6.5.9, 6.6.5.10) | `PRIVATE` method or variable: its own block only. `PROTECTED`: its block and the blocks derived from it |
| Inherited in-outs (6.6.5.5.2 rule 2) | A derived block's body uses its base's `VAR_IN_OUT` as its own (through the binding), and a call of the derived block binds the base's in-outs as well as its own; positional parameters list the base's first |
| Library | A library block may EXTEND a block of the same library. Its manifest entry names the base (`extends`, `isAbstract`) and lists the inherited inputs, outputs, in-outs and locals before its own, so a program instantiates and calls it like any block. A program block extending a library block is not supported yet (the base's variables are not in its scope) |

### Interfaces (6.6.6)

| Rule | Notes |
|------|-------|
| Method prototypes (6.6.6.3) | `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and a result only; any other section is refused |
| IMPLEMENTS (6.6.6.4) | One or more interfaces. Every prototype, inherited ones included, must be implemented (else the block must be `ABSTRACT`) with the same signature — names, types and order of all parameters and the result (§3.87) — and `PUBLIC` or `INTERNAL` access. Only interfaces may be named |
| EXTENDS (6.6.6.6) | An interface may extend any number of interfaces and inherits their prototypes. Refused: a base that is not an interface, recursion, and a prototype repeating one of a base. An interface reached along several paths (`A1`, `A2` both extending `A`, a block implementing both) is one base |
| Interface variable (6.6.6.2 b, 6.6.6.5) | A reference to an instance, `NULL` until assigned. Declared in `VAR`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_TEMP`, as a method or function input or result, and as an array element type. Initial value: an instance, another interface variable or `NULL` |
| Assignment (6.6.6.5.1) | Takes an instance of a block implementing the interface or derived from one, a variable of the same or a derived interface, or `NULL` — in `:=`, in an initial value and when passed to an input (`pump(Motor := motor1)`). Anything else is refused; an interface into a non-interface variable needs `?=` |
| Comparison (6.6.6.5.1) | `=` and `<>` with a variable of the same interface (same instance, or both `NULL`) or with `NULL`. Other operators and other types are refused |
| Method call | `m.M(...)` on an interface variable, an element (`motors[i].M()`) or a member path. An array element of function block instances takes method calls the same way |
| NULL method call (6.6.6.5.2) | A runtime error, reported like a NULL `REF_TO` dereference: `NullReferenceException` where the build has exceptions (the host runtime stops the POU), `iec_runtime_fault(IecFault::NullReference)` on boards built without them. Check `m <> NULL` first |
| Not an in-out (6.6.6.2 b) | A `VAR_IN_OUT` of an interface type is refused. An array of interface references is an array variable, which `In_Out_Var_Decl` admits (`Array_Var_Decl`, `Array_Conform_Decl`), so `VAR_IN_OUT m : ARRAY[*] OF I_MOTOR` is accepted |
| Not a global (Annex A) | `Global_Var_Decl` and `External_Decl` admit no interface type: an interface-typed `VAR_GLOBAL` / `VAR_EXTERNAL` is refused |
| Global instance | A shared global instance (`VAR_EXTERNAL`, file-level global) cannot be assigned to an interface variable or be the source of `?=`: it is accessed under its own lock, which a reference would bypass. Not implemented |
| Assignment attempt `?=` (6.6.6.7) | Table 52 feature 1: target an interface variable, source an interface variable, a block instance or `NULL`; the result is a reference when the instance implements the target interface, else `NULL`. Uses no RTTI (boards build with `-fno-rtti`). Feature 2, `?=` to a `REF_TO`, and `ST?` in IL are not implemented |
| Debugger and RETAIN | An interface variable holds no value of its own: it is not listed in the debug map and is not retained |
| Library | A block from a library archive may take and use interfaces (`VAR_INPUT Motor : I_MOTOR`). The manifest does not describe interfaces yet, so a program cannot declare a variable of a library's interface type |

## Standard Functions

All IEC 61131-3 standard functions are implemented in the C++ runtime:

| Category | Functions |
|----------|-----------|
| Numeric | ABS, SQRT, LN, LOG, EXP, EXPT |
| Trigonometric | SIN, COS, TAN, ASIN, ACOS, ATAN, ATAN2 |
| Selection | SEL, MIN, MAX, LIMIT, MUX |
| Comparison | GT, GE, EQ, LE, LT, NE |
| Bitwise | AND, OR, XOR, NOT, MOVE |
| Bit Shift | SHL, SHR, ROL, ROR |
| Type Conversion | *_TO_* (INT_TO_REAL, DINT_TO_STRING, etc.) |
| String | LEN, LEFT, RIGHT, MID, CONCAT, FIND, REPLACE, INSERT, DELETE, UPPER, LOWER, TRIM |
| System | ADR, SIZEOF |

## Standard Function Blocks

Bundled as a compiled `.stlib` library (`libs/iec-standard-fb.stlib`):

| FB | Description |
|----|-------------|
| TON | On-delay timer |
| TOF | Off-delay timer |
| TP | Pulse timer |
| CTU | Count-up counter |
| CTD | Count-down counter |
| CTUD | Up/down counter |
| R_TRIG | Rising edge detector |
| F_TRIG | Falling edge detector |
| SR | Set-dominant bistable |
| RS | Reset-dominant bistable |

Both counting inputs are sampled on the rising edge, as IEC 61131-3 declares them
(`CU : BOOL R_EDGE`, `CD : BOOL R_EDGE`). A count is registered on the scan where
the input goes FALSE to TRUE, for `CD` exactly as for `CU`.

The counting range follows CODESYS rather than the standard's `PVmin`/`PVmax`:
counting up stops at `PV`, which CODESYS documents as the "upper limit for
incrementing", and counting down stops at 0, which it decrements towards "as long
as `CV` is greater than 0". CODESYS reaches that range by typing `CV` and `PV` as
`WORD`, a deviation from IEC that it documents; these blocks keep the IEC types
and express the same range through the `PV` and 0 guards.

`CTUD` keeps the standard's `IF NOT (CU AND CD)` guard, so simultaneous rising
edges on `CU` and `CD` leave `CV` unchanged. CODESYS does not document that case.

## Project Structure

| Feature | Status | Notes |
|---------|--------|-------|
| CONFIGURATION | Supported | |
| RESOURCE ... ON | Supported | |
| TASK ... WITH INTERVAL | Supported | |
| Program instances | Supported | `name : programType` with task assignment |
| VAR_GLOBAL in configuration | Supported | |
| Namespace configuration | Supported | Via pragmas |

## Language Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Nested comments `(* (* *) *)` | Supported | Arbitrary nesting depth |
| Pragmas `{...}` | Supported | Including `{external}` for inline C++ |
| Inline C++ | Supported | Via `{external ...}` pragma blocks |
| Inline function calls | Supported | Via `{call ...}` pragma |
| Global constants (`-D`) | Supported | CLI `-D NAME=VALUE`, emits `constexpr` |
| Dynamic memory | Supported | `__NEW(type)`, `__DELETE(ptr)` |
| POINTER TO | Supported | Full pointer type with dereference |
| Typed literals | Supported | `INT#5`, `DINT#42`, `REAL#3.14` |
| `__VARINFO` | Supported | CODESYS variable information; yields `__SYSTEM.VAR_INFO`. `Area` is always -1 and `BitAddress` 0 — OpenPLC has no device memory-area numbering |
| Generic parameters | Supported | `ANY`, `ANY_INT`, … on `VAR_INPUT` of a FUNCTION, FUNCTION_BLOCK or METHOD. Takes an elementary type, an array, an enumeration or a structure: the class names the composite (`TYPE_ARRAY`, `TYPE_ENUM`, `TYPE_USERDEF`). A structure also arrives with `TYPEDESC`, its member layout. Descriptor type `__SYSTEM.AnyType`, usable as an array element to carry arguments of mixed type |

## Not Yet Implemented

| Feature | Notes |
|---------|-------|
| UNION | CODESYS union type |
| FB_Init / FB_Exit | Constructor/destructor lifecycle methods |
| __QUERYINTERFACE | CODESYS runtime interface query; the IEC assignment attempt `?=` is supported |
| ACTION blocks | Named action blocks |
| TRY/CATCH/FINALLY | Exception handling |
| Generics | Parameterized types |
| Conditional compilation | Preprocessor-style conditionals |
