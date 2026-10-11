// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Type Code Generator
 *
 * Generates C++ type definitions from user-defined types (TYPE...END_TYPE blocks).
 * Handles structs, enums, arrays, subranges, and type aliases.
 */

import type {
  TypeDeclaration,
  StructDefinition,
  EnumDefinition,
  ArrayDefinition,
  SubrangeDefinition,
  TypeReference,
  Expression,
  LiteralExpression,
  VariableExpression,
  BinaryExpression,
  UnaryExpression,
} from "../frontend/ast.js";
import { TypeRegistry, isElementaryType } from "../semantic/type-registry.js";
import {
  formatArrayType,
  formatIntegerLiteral,
  translateIECString,
} from "./codegen-utils.js";
import { wrapReferenceChain } from "./reference-types.js";
import { mangledMemberName } from "./member-mangling.js";
import {
  TypeDescriptorGenerator,
  typeDescDeclaration,
} from "./type-descriptor-gen.js";
import {
  parseDateLiteralToDays,
  parseDtLiteralToNs,
  parseTimeLiteral,
  parseTodLiteralToNs,
} from "../project-model.js";
import {
  buildEnumMemberMap,
  type EnumMemberEntry,
} from "../semantic/type-utils.js";
import {
  generateInitializerValue,
  type StructInitEmitter,
} from "./struct-init-codegen.js";

/**
 * Options for type code generation
 */
export interface TypeCodeGenOptions {
  indent: string;
  lineEnding: string;
  /** Wrap each generated type's emission with `//@chunk:begin/end:type:<NAME>`
   *  marker comments. Off by default; the library compiler enables it so
   *  it can slice per-symbol chunks for tree-shaking. See
   *  `CodeGenOptions.emitChunkMarkers`. */
  emitChunkMarkers: boolean;
  /** Whether a type name is user-defined, for the shared member-mangling rule
   *  (see `member-mangling.ts`). `CodeGenerator` injects its own resolution,
   *  which also recognises function blocks and programs; standalone use falls
   *  back to "anything that is not elementary", all a bare TypeCodeGenerator
   *  can tell from a list of type declarations. */
  isUserDefinedType: (typeName: string) => boolean;
  /** Library STRUCTs with a layout table, which a struct here may nest. */
  externalStructs?: readonly import("./type-descriptor-gen.js").ExternalStruct[];
  /** Enumerated types a library declares, which a struct here may hold. */
  externalEnums?: readonly string[];
  /** The compilation's bare-enumerator lookup (member name, upper case → owning
   *  enumeration): a linked library's enumerations and every one of the
   *  project's, not only those in the types emitted here. `CodeGenerator`
   *  passes the map its own expressions qualify by, so an element default
   *  (`mode := LM_AUTO`) names `LibMode::LM_AUTO` exactly as a variable
   *  initialiser does. Standalone use falls back to the enumerations among
   *  the types given. */
  enumMembers?: ReadonlyMap<string, EnumMemberEntry>;
}

/**
 * Default type code generation options
 */
export const defaultTypeCodeGenOptions: TypeCodeGenOptions = {
  indent: "    ",
  lineEnding: "\n",
  emitChunkMarkers: false,
  isUserDefinedType: (typeName: string) =>
    !isElementaryType(typeName.toUpperCase()),
};

/**
 * Map IEC elementary type names to C++ type names
 */
const IEC_TO_CPP_TYPE: Record<string, string> = {
  BOOL: "BOOL_t",
  BYTE: "BYTE_t",
  WORD: "WORD_t",
  DWORD: "DWORD_t",
  LWORD: "LWORD_t",
  SINT: "SINT_t",
  INT: "INT_t",
  DINT: "DINT_t",
  LINT: "LINT_t",
  USINT: "USINT_t",
  UINT: "UINT_t",
  UDINT: "UDINT_t",
  ULINT: "ULINT_t",
  __XWORD: "XWORD_t",
  REAL: "REAL_t",
  LREAL: "LREAL_t",
  TIME: "TIME_t",
  DATE: "DATE_t",
  TIME_OF_DAY: "TOD_t",
  TOD: "TOD_t",
  DATE_AND_TIME: "DT_t",
  DT: "DT_t",
  LTIME: "LTIME_t",
  LDATE: "LDATE_t",
  LTOD: "LTOD_t",
  LDT: "LDT_t",
  CHAR: "CHAR_t",
  WCHAR: "WCHAR_t",
  STRING: "IECString<254>",
  WSTRING: "IECWString<254>",
};

/**
 * Map IEC elementary type names to their IECVar-wrapped C++ type names.
 * Used for struct fields and array elements that need per-element forcing.
 */
export const IEC_TO_CPP_VAR_TYPE: Record<string, string> = {
  BOOL: "IEC_BOOL",
  BYTE: "IEC_BYTE",
  WORD: "IEC_WORD",
  DWORD: "IEC_DWORD",
  LWORD: "IEC_LWORD",
  SINT: "IEC_SINT",
  INT: "IEC_INT",
  DINT: "IEC_DINT",
  LINT: "IEC_LINT",
  USINT: "IEC_USINT",
  UINT: "IEC_UINT",
  UDINT: "IEC_UDINT",
  ULINT: "IEC_ULINT",
  __XWORD: "IEC_XWORD",
  REAL: "IEC_REAL",
  LREAL: "IEC_LREAL",
  TIME: "IEC_TIME",
  DATE: "IEC_DATE",
  TIME_OF_DAY: "IEC_TOD",
  TOD: "IEC_TOD",
  DATE_AND_TIME: "IEC_DT",
  DT: "IEC_DT",
  LTIME: "IEC_LTIME",
  LDATE: "IEC_LDATE",
  LTOD: "IEC_LTOD",
  LDT: "IEC_LDT",
  CHAR: "IEC_CHAR",
  WCHAR: "IEC_WCHAR",
};

/**
 * The C++ type of a struct field or type alias declared POINTER TO, lowered the
 * way a pointer variable is: `IEC_Ptr<T>` accepts the address of any type; a
 * raw `T*` does not, so `pByte := ADR(anInt)` type-checked and then failed in
 * C++. `cppType` is the type without the pointer level (returned unchanged when
 * the outermost level is not POINTER TO); `rawType` is the unwrapped element
 * (`INT_t`, a UDT name, or the array type). With more levels, the pointee is
 * itself a reference variable, so `POINTER TO POINTER TO INT` is
 * `IEC_Ptr<IEC_Ptr<INT_t>>` and `POINTER TO REF_TO INT` is
 * `IEC_Ptr<IEC_REF_TO<INT_t>>`.
 */
function pointerFieldType(
  typeRef: TypeReference,
  cppType: string,
  rawType: string,
): string {
  const chain = typeRef.referenceChain ?? [typeRef.referenceKind];
  if (chain[0] !== "pointer_to") return cppType;
  return wrapReferenceChain(chain, rawType);
}

/** A field or alias whose outermost level is REF_TO or REFERENCE TO. */
function isReferenceField(typeRef: TypeReference): boolean {
  return (
    typeRef.referenceKind === "ref_to" ||
    typeRef.referenceKind === "reference_to"
  );
}

/**
 * Type Code Generator for user-defined types
 */
export class TypeCodeGenerator {
  private options: TypeCodeGenOptions;
  private output: string[] = [];
  /** Track known enum type names (uppercase) so struct fields can use IEC_ wrapper */
  private knownEnumNames: Set<string> = new Set();
  /** Emits the layout tables a block walks when handed a STRUCT on an ANY
   *  pin. Rebuilt per run, since it indexes the type list. */
  private descriptors: TypeDescriptorGenerator | undefined;

  /** UPPER(names) of the STRUCT types this run emitted a layout table for.
   *  A member codegen could not describe suppresses the whole table, so a
   *  call site must ask rather than assume every struct has one. */
  readonly describedTypes: Set<string> = new Set();

  /** The layout-table DEFINITIONS of `describedTypes`, in emission order. The
   *  header gets only an `extern` declaration; the caller emits these once,
   *  in configuration.cpp (see `type-descriptor-gen.ts`). */
  readonly descriptorDefinitions: Array<{ typeName: string; lines: string[] }> =
    [];

  /** STRUCT types that got no layout table, and why. Surfaced as warnings by
   *  the caller — see `CodeGenerator.emitTypeDeclarations`. */
  readonly undescribedTypes: Array<{
    typeName: string;
    member: string;
    reason: string;
  }> = [];
  /** Reverse map: enum member name (upper case) → owning enum type */
  private enumMemberToType: ReadonlyMap<string, EnumMemberEntry> = new Map();
  /** Set while an enumeration's member values are emitted: its own members
   *  (upper case), named bare inside the enum body, where the type's name is
   *  not yet declared. Their arithmetic is integer, so AND/OR/XOR are bitwise. */
  private enumValueMembers: Set<string> | undefined;

  /**
   * Hooks for structure-initializer lowering (a STRUCT element whose own default
   * is a structure initializer: `origin : Point := (x := 0.0);`).
   *
   * The type generator works from one type definition at a time and has no
   * cross-type field index, so it cannot resolve nested element types or the
   * member-name collision mangle. Nested levels take their type from
   * `decltype(...)` of the member being assigned, which needs no metadata.
   */
  private structInitEmitter: StructInitEmitter = {
    emitValue: (value: Expression): string => this.expressionToCpp(value),
    memberName: (fieldName: string): string => fieldName,
    fieldTypeName: (): undefined => undefined,
    arrayElementTypeName: (): undefined => undefined,
  };

  constructor(options: Partial<TypeCodeGenOptions> = {}) {
    this.options = { ...defaultTypeCodeGenOptions, ...options };
  }

  /**
   * Generate C++ type definitions from a type registry.
   * Types are generated in dependency order.
   */
  generateFromRegistry(registry: TypeRegistry): string {
    this.output = [];
    const types = registry.getTypesInDependencyOrder();
    return this.generateTypes(types);
  }

  /**
   * Generate C++ type definitions from an array of type declarations.
   * Assumes types are already in dependency order.
   */
  generateTypes(types: TypeDeclaration[]): string {
    this.output = [];
    // A library's enumerations too: a field of one must be the forceable
    // `IEC_<Name>` wrapper the debugger addresses, not the bare C++ enum.
    this.knownEnumNames = new Set(
      (this.options.externalEnums ?? []).map((n) => n.toUpperCase()),
    );
    this.descriptors = new TypeDescriptorGenerator({
      types,
      externalStructs: this.options.externalStructs ?? [],
      externalEnums: this.options.externalEnums ?? [],
      mapStructFieldTypeToCpp: (
        name: string,
        maxLength?: number | string,
      ): string => this.mapStructFieldTypeToCpp(name, maxLength),
      mapTypeToCpp: (name: string): string => this.mapTypeToCpp(name),
      isUserDefinedType: this.options.isUserDefinedType,
      indent: this.options.indent,
    });

    // Reverse map for bare enum member qualification. Built from these types
    // alone it misses a library's enumerations (and a project enumeration
    // emitted in an earlier batch), whose members then came out bare — and a
    // typed enumeration's members are not in scope bare (`X__NAMED`).
    this.enumMemberToType =
      this.options.enumMembers ??
      buildEnumMemberMap(
        types
          .filter(
            (t) =>
              t.definition.kind === "EnumDefinition" &&
              t.inline?.owner === undefined,
          )
          .map((t) => ({
            name: t.name,
            members: (
              t.definition as import("../frontend/ast.js").EnumDefinition
            ).members.map((m) => m.name),
          })),
      );

    if (types.length === 0) {
      return "";
    }

    this.emit("// User-defined types");
    this.emit("");

    for (const type of types) {
      if (this.options.emitChunkMarkers) {
        this.emit(`//@chunk:begin:type:${type.name}`);
      }
      this.generateTypeDeclaration(type);
      if (this.options.emitChunkMarkers) {
        this.emit(`//@chunk:end:type:${type.name}`);
      }
    }

    return this.output.join(this.options.lineEnding);
  }

  /**
   * Generate a single type declaration
   */
  private generateTypeDeclaration(type: TypeDeclaration): void {
    const def = type.definition;

    switch (def.kind) {
      case "StructDefinition": {
        this.generateStructType(type.name, def);
        // Struct fields already contain IECVar leaves — identity alias
        this.emit(`using IEC_${type.name} = ${type.name};`);
        this.emit("");
        // The table says `sizeof(<name>)`, so its definition (in
        // configuration.cpp, after this header) needs the complete struct.
        // Here, beside the struct, only the declaration every TU links to.
        const tables = this.descriptors?.generate(type.name, def) ?? [];
        if (tables.length > 0) {
          this.emit(typeDescDeclaration(type.name));
          this.emit("");
          this.descriptorDefinitions.push({
            typeName: type.name,
            lines: tables,
          });
          this.describedTypes.add(type.name.toUpperCase());
        }
        for (const skip of this.descriptors?.skipped ?? []) {
          if (
            !this.undescribedTypes.some((u) => u.typeName === skip.typeName)
          ) {
            this.undescribedTypes.push(skip);
          }
        }
        break;
      }
      case "EnumDefinition":
        this.knownEnumNames.add(type.name.toUpperCase());
        this.generateEnumType(type.name, def);
        // Generate IEC_ wrapper for enum variables using IEC_ENUM
        this.emit(`using IEC_${type.name} = IEC_ENUM<${type.name}>;`);
        this.emit("");
        break;
      case "ArrayDefinition":
        this.generateArrayType(type.name, def);
        // Array elements already contain IECVar leaves — identity alias
        this.emit(`using IEC_${type.name} = ${type.name};`);
        this.emit("");
        break;
      case "SubrangeDefinition":
        this.generateSubrangeType(type.name, def);
        // Generate IEC_ wrapper aliasing to base type's wrapper
        this.generateIecWrapperForSubrange(type.name, def);
        break;
      case "TypeReference":
        this.generateTypeAlias(type.name, def);
        // Generate IEC_ wrapper aliasing to base type's wrapper
        this.generateIecWrapperForAlias(type.name, def);
        break;
    }
  }

  /**
   * Generate IEC_ wrapper for a type alias
   */
  private generateIecWrapperForAlias(name: string, def: TypeReference): void {
    const baseName = def.name.toUpperCase();
    if (isElementaryType(baseName)) {
      // Alias to elementary type - use the existing IEC_ wrapper
      this.emit(`using IEC_${name} = IEC_${baseName};`);
    } else {
      // Alias to user-defined type - use IECVar wrapper
      this.emit(`using IEC_${name} = IECVar<${name}>;`);
    }
    this.emit("");
  }

  /**
   * Generate IEC_ wrapper for a subrange type
   */
  private generateIecWrapperForSubrange(
    name: string,
    def: SubrangeDefinition,
  ): void {
    const baseName = def.baseType.name.toUpperCase();
    if (isElementaryType(baseName)) {
      // Subrange of elementary type - use the existing IEC_ wrapper
      this.emit(`using IEC_${name} = IEC_${baseName};`);
    } else {
      // Subrange of user-defined type - use IECVar wrapper
      this.emit(`using IEC_${name} = IECVar<${name}>;`);
    }
    this.emit("");
  }

  /**
   * Generate a struct type definition
   *
   * ST:
   *   MyStruct : STRUCT
   *     x : INT;
   *     y : REAL;
   *   END_STRUCT;
   *
   * C++:
   *   struct MyStruct {
   *       INT_t x;
   *       REAL_t y;
   *   };
   */
  private generateStructType(name: string, def: StructDefinition): void {
    this.emit(`struct ${name} {`);

    for (const field of def.fields) {
      let cppType: string;
      if (field.type.arrayDimensions && field.type.elementTypeName) {
        // Inline array type: emit Array1D/2D/3D<WrappedElementType, bounds...>
        const elemCpp = this.arrayElementTypeToCpp(
          field.type.elementTypeName,
          field.type.elementReferenceChain,
          field.type.elementMaxLength,
        );
        cppType = formatArrayType(elemCpp, field.type.arrayDimensions);
      } else {
        cppType = this.mapStructFieldTypeToCpp(
          field.type.name,
          field.type.maxLength,
        );
      }
      const rawType = field.type.arrayDimensions
        ? cppType
        : this.mapTypeToCpp(field.type.name);
      cppType = isReferenceField(field.type)
        ? // REF_TO / REFERENCE TO: the same wrapper a variable gets.
          wrapReferenceChain(
            field.type.referenceChain ?? [field.type.referenceKind],
            rawType,
          )
        : pointerFieldType(field.type, cppType, rawType);
      for (const fieldName of field.names) {
        // One rule, shared with the class definition and the debug table — see
        // member-mangling.ts. Compare against the ST type name, not cppType
        // (which may carry a pointer '*' suffix). A STRUCT implements no
        // interfaces, so only the type collision can apply here.
        const emitName = mangledMemberName(fieldName, field.type.name, {
          isUserDefinedType: this.options.isUserDefinedType,
        });
        if (field.initialValue) {
          // Routes composite initialisers (array literals, structure
          // initializers) through the shared lowering and everything else
          // through expressionToCpp. Before this, an array-literal default on a
          // STRUCT element fell through to expressionToCpp's `0` fallback and
          // the `isArrayType` guard below turned it into `{}` — the declared
          // values were dropped with no diagnostic.
          const initVal = generateInitializerValue(
            field.initialValue,
            cppType,
            field.type.name,
            this.structInitEmitter,
          );
          // Array types can't be initialized with = 0; use {} instead
          const isArrayType = /^Array[123]D</.test(cppType);
          if (isArrayType && initVal === "0") {
            this.emit(`${this.options.indent}${cppType} ${emitName}{};`);
          } else {
            this.emit(
              `${this.options.indent}${cppType} ${emitName} = ${initVal};`,
            );
          }
        } else {
          if (field.type.referenceKind === "pointer_to") {
            this.emit(
              `${this.options.indent}${cppType} ${emitName} = nullptr;`,
            );
          } else {
            this.emit(`${this.options.indent}${cppType} ${emitName}{};`);
          }
        }
      }
    }

    this.emit("};");
    this.emit("");
  }

  /**
   * Generate an enum type definition
   *
   * Enumeration (IEC 61131-3 Ed.3 6.4.4.2), a scoped enum on INT so its
   * storage matches the INT debug leaf on every target:
   *   TrafficLight : (RED, YELLOW, GREEN);
   *   enum class TrafficLight : INT_t { RED, YELLOW, GREEN };
   *
   * Data type with named values (6.4.4.3), whose values are values of the base
   * type, so an unscoped enum (it converts to the base integer) kept in a
   * struct so its names stay qualified:
   *   State : USINT (IDLE := 0, RUNNING := 1);
   *   struct State__NAMED { enum State : USINT_t { IDLE = 0, RUNNING = 1 }; };
   *   using State = State__NAMED::State;
   */
  private generateEnumType(name: string, def: EnumDefinition): void {
    const own = new Set(def.members.map((m) => m.name.toUpperCase()));
    const members = def.members.map((member) => {
      if (member.value) {
        this.enumValueMembers = own;
        try {
          return `${member.name} = ${this.expressionToCpp(member.value)}`;
        } finally {
          this.enumValueMembers = undefined;
        }
      }
      return member.name;
    });

    if (def.baseType) {
      const base = this.mapTypeToCpp(def.baseType.name);
      this.emit(
        `struct ${name}__NAMED { enum ${name} : ${base} { ${members.join(", ")} }; };`,
      );
      this.emit(`using ${name} = ${name}__NAMED::${name};`);
    } else {
      this.emit(`enum class ${name} : INT_t { ${members.join(", ")} };`);
    }
    this.emit("");
  }

  /**
   * Generate an array type definition
   *
   * ST:
   *   IntArray : ARRAY[0..9] OF INT;
   *   Matrix : ARRAY[0..2, 0..2] OF REAL;
   *   OffsetArray : ARRAY[3..7] OF INT;
   *
   * C++:
   *   using IntArray = Array1D<INT_t, 0, 9>;
   *   using Matrix = Array2D<REAL_t, 0, 2, 0, 2>;
   *   using OffsetArray = Array1D<INT_t, 3, 7>;
   *
   * Uses Array1D/2D/3D templates which preserve index bounds for proper
   * IEC 61131-3 array semantics (arrays can have arbitrary start indices).
   */
  private generateArrayType(name: string, def: ArrayDefinition): void {
    const elementKind = def.elementType.referenceKind;
    const elementType = this.arrayElementTypeToCpp(
      def.elementType.name,
      elementKind === undefined || elementKind === "none"
        ? undefined
        : (def.elementType.referenceChain ?? [elementKind]),
      def.elementType.maxLength,
    );
    const numDims = def.dimensions.length;

    // Collect bounds for all dimensions (skip variable-length dimensions)
    const bounds: Array<{ start: number; end: number }> = [];
    for (const dim of def.dimensions) {
      if (dim && !dim.isVariableLength && dim.start && dim.end) {
        const start = this.evaluateConstantExpression(dim.start);
        const end = this.evaluateConstantExpression(dim.end);
        bounds.push({ start, end });
      }
    }

    // Generate appropriate Array template based on dimensions
    let cppType: string;
    if (numDims <= 3 && bounds.length === numDims) {
      cppType = formatArrayType(elementType, bounds);
    } else {
      // Fallback for higher dimensions: use nested std::array (loses bounds info)
      // This maintains backwards compatibility but loses arbitrary index support
      cppType = elementType;
      for (let i = def.dimensions.length - 1; i >= 0; i--) {
        const dim = def.dimensions[i];
        if (dim && !dim.isVariableLength && dim.start && dim.end) {
          const start = this.evaluateConstantExpression(dim.start);
          const end = this.evaluateConstantExpression(dim.end);
          const size = end - start + 1;
          cppType = `std::array<${cppType}, ${size}>`;
        }
      }
    }

    this.emit(`using ${name} = ${cppType};`);
    this.emit("");
  }

  /**
   * Generate a subrange type definition
   *
   * ST:
   *   Percentage : INT(0..100);
   *
   * C++:
   *   using Percentage = INT_t;
   *
   * Note: Runtime bounds checking would be implemented separately.
   * For now, we just create a type alias.
   */
  private generateSubrangeType(name: string, def: SubrangeDefinition): void {
    const baseType = this.mapTypeToCpp(def.baseType.name);
    const lower = this.expressionToCpp(def.lowerBound);
    const upper = this.expressionToCpp(def.upperBound);

    this.emit(`using ${name} = ${baseType};`);
    this.emit(`constexpr ${baseType} ${name}_MIN = ${lower};`);
    this.emit(`constexpr ${baseType} ${name}_MAX = ${upper};`);
    this.emit("");
  }

  /**
   * Generate a type alias
   *
   * ST:
   *   MyInt : INT;
   *
   * C++:
   *   using MyInt = INT_t;
   */
  private generateTypeAlias(name: string, def: TypeReference): void {
    let cppType: string;
    if (def.arrayDimensions && def.elementTypeName) {
      // POINTER TO ARRAY[...] OF T — use array template
      const elemCpp = def.elementReferenceChain
        ? wrapReferenceChain(
            def.elementReferenceChain,
            this.mapTypeToCpp(def.elementTypeName),
          )
        : this.mapTypeToCpp(def.elementTypeName);
      cppType = formatArrayType(elemCpp, def.arrayDimensions);
    } else {
      cppType = this.mapTypeToCpp(def.name);
    }
    const rawType = def.arrayDimensions ? cppType : this.mapTypeToCpp(def.name);
    cppType = isReferenceField(def)
      ? wrapReferenceChain(def.referenceChain ?? [def.referenceKind], rawType)
      : pointerFieldType(def, cppType, rawType);
    this.emit(`using ${name} = ${cppType};`);
    this.emit("");
  }

  /**
   * The C++ element type of an array: the IECVar-wrapped type for a value
   * element, or for an element declared POINTER TO / REF_TO the wrapper a
   * variable of that type gets (`IEC_Ptr<INT_t>`). `maxLength` is a STRING /
   * WSTRING element's declared length — `ARRAY[1..4] OF STRING(60)` — which
   * would otherwise fall back to 254.
   */
  private arrayElementTypeToCpp(
    typeName: string,
    referenceChain: readonly string[] | undefined,
    maxLength?: number | string,
  ): string {
    return referenceChain
      ? wrapReferenceChain(referenceChain, this.mapTypeToCpp(typeName))
      : this.mapStructFieldTypeToCpp(typeName, maxLength);
  }

  /**
   * Map an IEC type name to its C++ equivalent (raw/unwrapped)
   */
  mapTypeToCpp(typeName: string): string {
    const upperName = typeName.toUpperCase();

    if (isElementaryType(upperName)) {
      return IEC_TO_CPP_TYPE[upperName] ?? `${upperName}_t`;
    }

    return typeName;
  }

  /**
   * Map a type name to its IECVar-wrapped C++ equivalent for struct fields
   * and array elements. Wraps elementary types with IECVar for per-field forcing.
   * Composites (structs, arrays, FBs) use bare names since their fields
   * already contain IECVar leaves.
   */
  mapStructFieldTypeToCpp(
    typeName: string,
    maxLength?: number | string,
  ): string {
    const upperName = typeName.toUpperCase();

    // STRING/WSTRING with optional length → IECStringVar/IECWStringVar (forceable)
    if (upperName === "STRING") {
      const len = maxLength ?? 254;
      return `IECStringVar<${len}>`;
    }
    if (upperName === "WSTRING") {
      const len = maxLength ?? 254;
      return `IECWStringVar<${len}>`;
    }

    // Elementary types → IEC_<TYPE> (IECVar-wrapped)
    if (isElementaryType(upperName)) {
      return IEC_TO_CPP_VAR_TYPE[upperName] ?? `IEC_${upperName}`;
    }

    // Enum types → IEC_<Name> (resolves to IEC_ENUM<Name> via alias)
    if (this.knownEnumNames.has(upperName)) {
      return `IEC_${typeName}`;
    }

    // Composite types (struct, array, FB) → bare name
    return typeName;
  }

  /**
   * Convert an AST expression to C++ code
   */
  private expressionToCpp(expr: Expression): string {
    switch (expr.kind) {
      case "LiteralExpression":
        return this.literalToCpp(expr);
      case "VariableExpression":
        return this.variableToCpp(expr);
      case "BinaryExpression":
        return this.binaryExprToCpp(expr);
      case "UnaryExpression":
        return this.unaryExprToCpp(expr);
      case "ParenthesizedExpression":
        return `(${this.expressionToCpp(expr.expression)})`;
      case "FunctionCallExpression":
        return `${expr.functionName}()`;
      default:
        return "0";
    }
  }

  private literalToCpp(expr: LiteralExpression): string {
    switch (expr.literalType) {
      case "BOOL":
        return expr.value === true ? "true" : "false";
      case "INT":
        // Same lowering the expression path uses, so a STRUCT element default
        // and the identical literal in a body can't disagree — and so a 64-bit
        // default keeps every digit (`String(expr.value)` rounds above 2^53).
        return formatIntegerLiteral(expr.rawValue, expr.value as number);
      case "STRING": {
        // IEC STRING literals carry their surrounding single quotes
        // in `rawValue` (`'wide hello'`); strip them before wrapping
        // in C++ double quotes — otherwise we end up with `"'…'"`.
        // The body then goes through the same `$`-escape translation the
        // expression emitter uses: a literal containing `"` or `\` (OSCAT's
        // HTML-entity tables, for one) would otherwise terminate the C++ string
        // early and fail to compile.
        const inner = expr.rawValue.replace(/^'|'$/g, "");
        return `"${translateIECString(inner)}"`;
      }
      case "WSTRING": {
        // IEC WSTRING literals are double-quoted; strip either form
        // for safety. The C++ prefix is `u` (char16_t) — `L"…"`
        // (wchar_t) is 32-bit on Linux/AVR and wouldn't bind to
        // IECWStringVar's char16_t* ctor.
        const inner = expr.rawValue.replace(/^["']|["']$/g, "");
        return `u"${translateIECString(inner)}"`;
      }
      case "TIME": {
        const timeVal = parseTimeLiteral(String(expr.value));
        return `${timeVal.nanoseconds}LL`;
      }
      case "DATE":
        return `${parseDateLiteralToDays(String(expr.value))}LL`;
      case "TIME_OF_DAY":
        return `${parseTodLiteralToNs(String(expr.value))}LL`;
      case "DATE_AND_TIME":
        return `${parseDtLiteralToNs(String(expr.value))}LL`;
      default:
        return String(expr.value);
    }
  }

  private variableToCpp(expr: VariableExpression): string {
    let result = expr.name;
    const nameUpper = expr.name.toUpperCase();

    if (
      this.enumValueMembers?.has(nameUpper) === true &&
      expr.fieldAccess.length === 0 &&
      expr.subscripts.length === 0
    ) {
      return expr.name;
    }

    // Bare enum member: Stopped → Irrigation_State::Stopped
    const enumEntry = this.enumMemberToType.get(nameUpper);
    if (enumEntry?.typeName && expr.fieldAccess.length === 0) {
      return `${enumEntry.typeName}::${expr.name}`;
    }

    // Enum qualified access: TrafficState.RED → TrafficState::RED
    if (this.knownEnumNames.has(nameUpper) && expr.fieldAccess.length === 1) {
      return `${expr.name}::${expr.fieldAccess[0]}`;
    }

    for (const subscript of expr.subscripts) {
      result += `[${this.expressionToCpp(subscript)}]`;
    }

    for (const field of expr.fieldAccess) {
      result += `.${field}`;
    }

    if (expr.isDereference) {
      result = `*${result}`;
    }

    return result;
  }

  private binaryExprToCpp(expr: BinaryExpression): string {
    const left = this.expressionToCpp(expr.left);
    const right = this.expressionToCpp(expr.right);

    const opMap: Record<string, string> = {
      "+": "+",
      "-": "-",
      "*": "*",
      "/": "/",
      MOD: "%",
      "**": "/* pow */",
      AND: "&&",
      OR: "||",
      XOR: "^",
      "=": "==",
      "<>": "!=",
      "<": "<",
      ">": ">",
      "<=": "<=",
      ">=": ">=",
    };

    if (this.enumValueMembers) {
      opMap.AND = "&";
      opMap.OR = "|";
    }
    const cppOp = opMap[expr.operator] ?? expr.operator;
    return `${left} ${cppOp} ${right}`;
  }

  private unaryExprToCpp(expr: UnaryExpression): string {
    const operand = this.expressionToCpp(expr.operand);

    const opMap: Record<string, string> = {
      NOT: this.enumValueMembers ? "~" : "!",
      "-": "-",
      "+": "+",
    };

    const cppOp = opMap[expr.operator] ?? expr.operator;
    return `${cppOp}${operand}`;
  }

  /**
   * Evaluate a constant expression to a number.
   * Used for array dimension calculations.
   */
  private evaluateConstantExpression(expr: Expression): number {
    switch (expr.kind) {
      case "LiteralExpression":
        if (typeof expr.value === "number") {
          return expr.value;
        }
        return parseInt(String(expr.value), 10) || 0;
      case "UnaryExpression":
        if (expr.operator === "-") {
          return -this.evaluateConstantExpression(expr.operand);
        }
        return this.evaluateConstantExpression(expr.operand);
      case "BinaryExpression": {
        const left = this.evaluateConstantExpression(expr.left);
        const right = this.evaluateConstantExpression(expr.right);
        switch (expr.operator) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return Math.floor(left / right);
          case "MOD":
            return left % right;
          default:
            return 0;
        }
      }
      default:
        return 0;
    }
  }

  /**
   * Emit a line of output
   */
  private emit(line: string): void {
    this.output.push(line);
  }
}

/**
 * Generate C++ type definitions from a type registry
 */
export function generateTypeCode(
  registry: TypeRegistry,
  options?: Partial<TypeCodeGenOptions>,
): string {
  const generator = new TypeCodeGenerator(options);
  return generator.generateFromRegistry(registry);
}
