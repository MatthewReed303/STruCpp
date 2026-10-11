/**
 * Retain format 2: a program whose retained declarations changed takes back
 * every stored value whose variable still exists, by name.
 *
 * IEC 61131-3 6.5.6.1 rule 1 (p.57): on a warm restart a RETAIN variable takes
 * "the values the variables had when the resource or configuration was
 * stopped". Format 1 refused the whole blob on any declaration change, so
 * adding one member to a RETAIN struct reset every setting, total and run
 * hour. These tests build TWO real programs — the one that saved and the one
 * that restores — from ST, through the real generated debug tables and
 * iec_retain.hpp, and move the blob between them:
 *
 *   - the upgrade matrix: add, remove, reorder, retype (IEC Figure 12
 *     conversions kept, everything else refused), STRING and ARRAY resize,
 *     a renamed instance, a changed enumeration;
 *   - format 1 compatibility: a format-1 blob of the same layout still loads;
 *   - safety: every kind of corruption writes nothing at all.
 *
 * Every program is driven through the debug table by path, so the test reads
 * the values the restore actually wrote, not what a C++ name happens to be.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD } from "./test-helpers.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");
const describeIfGpp = hasGpp ? describe : describe.skip;

/** The harness every program is linked with. Commands run in argv order. */
const MAIN_CPP = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;

static uint8_t wr(uint8_t a, uint16_t e, const uint8_t* b, uint16_t n) { return debug::handle_write(a, e, b, n); }
static uint16_t sz(uint8_t a, uint16_t e) { return debug::handle_size(a, e); }
static uint16_t rd(uint8_t a, uint16_t e, uint8_t* d) { return debug::handle_read(a, e, d); }
static const retain::Host kHost = {
  &debug::handle_retain_leaf, rd, wr, &debug::handle_read_text, &debug::handle_write_text, sz,
};

static std::vector<uint8_t> unhex(const char* s) {
  std::vector<uint8_t> out;
  for (size_t i = 0; s[i] && s[i + 1]; i += 2) {
    char b[3] = {s[i], s[i + 1], 0};
    out.push_back((uint8_t)strtoul(b, nullptr, 16));
  }
  return out;
}

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    const char* cmd = argv[i];
    if (!strcmp(cmd, "set")) {             // set <file>: lines "arr elem kind hex"
      FILE* f = fopen(argv[++i], "r");
      unsigned a, e; char kind[8], hex[2048];
      while (fscanf(f, "%u %u %7s %2047s", &a, &e, kind, hex) == 4) {
        std::vector<uint8_t> v = unhex(strcmp(hex, "-") ? hex : "");
        uint8_t st = kind[0] == 't'
          ? debug::handle_write_text((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size())
          : debug::handle_write((uint8_t)a, (uint16_t)e, v.data(), (uint16_t)v.size());
        if (st != 0x7E) { printf("SETFAIL %u %u %02x\\n", a, e, st); return 2; }
      }
      fclose(f);
    } else if (!strcmp(cmd, "save") || !strcmp(cmd, "save1")) {
      static uint8_t blob[65535];
      size_t n = !strcmp(cmd, "save")
        ? retain::pack2(blob, sizeof blob, kHost)
        : retain::pack(blob, sizeof blob, rd, sz);
      if (!strcmp(cmd, "save") && n != retain::blob_size2(kHost)) { printf("SIZEMISMATCH\\n"); return 3; }
      FILE* f = fopen(argv[++i], "wb"); fwrite(blob, 1, n, f); fclose(f);
      printf("SAVED %zu\\n", n);
    } else if (!strcmp(cmd, "load")) {
      static uint8_t blob[65535];
      FILE* f = fopen(argv[++i], "rb"); size_t n = fread(blob, 1, sizeof blob, f); fclose(f);
      retain::Report r;
      uint8_t res = (uint8_t)retain::unpack2(blob, n, kHost, &r);
      const retain::Report& last = retain::last_report();
      printf("REPORT %u %u %u %u %u %u %u %u %08x %08x %d\\n", res, r.format, r.kept, r.converted,
             r.truncated, r.added, r.dropped, r.refused, r.stored_layout, r.program_layout,
             memcmp(&last, &r, sizeof r) == 0);
    } else if (!strcmp(cmd, "dump")) {
      for (uint16_t k = 0; k < debug::retain_var_count; ++k) {
        debug::RetainLeafInfo l; debug::handle_retain_leaf(k, &l);
        uint8_t buf[1024]; uint16_t n;
        if (l.tag == debug::TAG_STRING || l.tag == debug::TAG_WSTRING) {
          n = debug::handle_read_text(l.arr, l.elem, buf, sizeof buf);
        } else {
          n = debug::handle_read(l.arr, l.elem, buf);
        }
        printf("LEAF %u %u ", l.arr, l.elem);
        for (uint16_t b = 0; b < n; ++b) printf("%02x", buf[b]);
        printf(n ? "\\n" : "-\\n");
      }
      printf("FORCED %d\\n", 0);
    } else if (!strcmp(cmd, "forced")) {   // forced <arr> <elem>
      unsigned a = (unsigned)atoi(argv[++i]), e = (unsigned)atoi(argv[++i]);
      uint16_t n; (void)debug::handle_ptr((uint8_t)a, (uint16_t)e, &n);
      printf("SIZE %u\\n", n);
    }
  }
  return 0;
}
`;

type Leaf = { path: string; type: string; arr: number; elem: number };
type Built = { bin: string; leaves: Map<string, Leaf>; retained: Leaf[]; map: any };

let tempDir: string;
let pch = 0;

function build(name: string, st: string, libraries?: StlibArchive[]): Built {
  const result = compile(st, {
    headerFileName: "generated.hpp",
    ...(libraries ? { libraries } : {}),
  });
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const dir = path.join(tempDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
  fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
  fs.writeFileSync(path.join(dir, "generated_debug.cpp"), result.debugTableCpp!);
  fs.writeFileSync(path.join(dir, "main.cpp"), MAIN_CPP);
  const bin = path.join(dir, "prog");
  execSync(
    `g++ -std=${CXX_STD} -O0 -I"${RUNTIME_INCLUDE}" -I"${dir}" -o "${bin}" ` +
      `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}" "${path.join(dir, "generated_debug.cpp")}"`,
    { encoding: "utf-8", stdio: "pipe" },
  );
  pch++;
  const map = result.debugMap!;
  const leaves = new Map<string, Leaf>();
  for (const l of map.leaves) leaves.set(l.path, { path: l.path, type: l.type, arr: l.arrayIdx, elem: l.elemIdx });
  const retained = (map.retainVars ?? []).map((v: any) => leaves.get(v.path)!);
  return { bin, leaves, retained, map };
}

/** Encode a value for `set`, by the leaf's IEC type. */
function enc(type: string, v: number | string | boolean): { kind: string; hex: string } {
  const b = (n: number, w: number, signed = true) => {
    const buf = Buffer.alloc(w);
    if (w === 8) buf.writeBigInt64LE(BigInt(v as number));
    else if (signed) buf.writeIntLE(v as number, 0, w);
    else buf.writeUIntLE(v as number, 0, w);
    return buf.toString("hex");
  };
  switch (type) {
    case "BOOL": return { kind: "s", hex: v ? "01" : "00" };
    case "SINT": return { kind: "s", hex: b(v as number, 1) };
    case "USINT": case "BYTE": return { kind: "s", hex: b(v as number, 1, false) };
    case "INT": return { kind: "s", hex: b(v as number, 2) };
    case "UINT": case "WORD": return { kind: "s", hex: b(v as number, 2, false) };
    case "DINT": return { kind: "s", hex: b(v as number, 4) };
    case "UDINT": case "DWORD": return { kind: "s", hex: b(v as number, 4, false) };
    case "LINT": case "TIME": return { kind: "s", hex: b(v as number, 8) };
    case "REAL": { const x = Buffer.alloc(4); x.writeFloatLE(v as number); return { kind: "s", hex: x.toString("hex") }; }
    case "LREAL": { const x = Buffer.alloc(8); x.writeDoubleLE(v as number); return { kind: "s", hex: x.toString("hex") }; }
    case "STRING": return { kind: "t", hex: Buffer.from(String(v), "latin1").toString("hex") || "-" };
    default: throw new Error(`enc: ${type}`);
  }
}

/** Decode a dumped value. */
function dec(type: string, hex: string): number | string | boolean {
  const buf = Buffer.from(hex === "-" ? "" : hex, "hex");
  switch (type) {
    case "BOOL": return buf[0] !== 0;
    case "SINT": return buf.readInt8(0);
    case "USINT": case "BYTE": return buf.readUInt8(0);
    case "INT": return buf.readInt16LE(0);
    case "UINT": case "WORD": return buf.readUInt16LE(0);
    case "DINT": return buf.readInt32LE(0);
    case "UDINT": case "DWORD": return buf.readUInt32LE(0);
    case "LINT": case "TIME": return Number(buf.readBigInt64LE(0));
    case "REAL": return Math.round(buf.readFloatLE(0) * 1000) / 1000;
    case "LREAL": return buf.readDoubleLE(0);
    case "STRING": return buf.toString("latin1");
    default: throw new Error(`dec: ${type}`);
  }
}

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf-8" });
}

/** Set `values` (by path) in program `p`, then save a blob (`save` or `save1`). */
function saveFrom(p: Built, values: Record<string, number | string | boolean>, file: string, how = "save") {
  const lines = Object.entries(values).map(([k, v]) => {
    const leaf = p.leaves.get(k);
    if (!leaf) throw new Error(`no leaf ${k}`);
    const { kind, hex } = enc(leaf.type, v);
    return `${leaf.arr} ${leaf.elem} ${kind} ${hex}`;
  });
  const vf = file + ".values";
  fs.writeFileSync(vf, lines.join("\n") + "\n");
  const out = run(p.bin, ["set", vf, how, file]);
  expect(out).toMatch(/SAVED \d+/);
}

type Report = {
  result: number; format: number; kept: number; converted: number; truncated: number;
  added: number; dropped: number; refused: number; lastMatches: boolean;
};

/** Load a blob into program `p` and return the report and every retained value by path. */
function loadInto(p: Built, file: string): { report: Report; values: Record<string, number | string | boolean> } {
  const out = run(p.bin, ["load", file, "dump"]);
  const m = /REPORT (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) \S+ \S+ (\d)/.exec(out)!;
  const report: Report = {
    result: +m[1]!, format: +m[2]!, kept: +m[3]!, converted: +m[4]!, truncated: +m[5]!,
    added: +m[6]!, dropped: +m[7]!, refused: +m[8]!, lastMatches: m[9] === "1",
  };
  const byAddr = new Map<string, Leaf>();
  for (const l of p.leaves.values()) byAddr.set(`${l.arr} ${l.elem}`, l);
  const values: Record<string, number | string | boolean> = {};
  for (const line of out.split("\n")) {
    const lm = /^LEAF (\d+) (\d+) (\S+)$/.exec(line);
    if (!lm) continue;
    const leaf = byAddr.get(`${lm[1]} ${lm[2]}`)!;
    values[leaf.path] = dec(leaf.type, lm[3]!);
  }
  return { report, values };
}

const OK = 0, STALE = 5, TRUNCATED = 6, BAD_CRC = 4, MIGRATED = 7, BAD_TRAILER = 8;

/** The program that saves. `members` and friends are spliced per variant. */
function program(opts: {
  cfg?: string;
  enumDef?: string;
  inst?: string;
  prog?: string;
} = {}): string {
  const cfg = opts.cfg ?? `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;`;
  const enumDef = opts.enumDef ?? `MODE_T : (OFF, AUTO, HAND) := OFF;`;
  const inst = opts.inst ?? "instance0";
  const prog = opts.prog ?? `
VAR RETAIN hours : LINT; starts : DINT; END_VAR`;
  return `TYPE
  ${enumDef}
  CFG_T : STRUCT${cfg}
  END_STRUCT;
END_TYPE
PROGRAM Main
${prog}
  hours := hours;
END_PROGRAM
CONFIGURATION Config0
  VAR_GLOBAL RETAIN CFG : CFG_T; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM ${inst} WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;
}

const LONG = "L".repeat(150) + "-tail";
const VALUES = {
  "CFG.LEVELHI": 2.25,
  "CFG.PUMPS": 7,
  "CFG.ENABLED": true,
  "CFG.SITE": "Posprop effluent",
  "CFG.NOTE": LONG,
  "CFG.SPARE[1]": 11,
  "CFG.SPARE[2]": 12,
  "CFG.SPARE[3]": 13,
  "CFG.SPARE[4]": 14,
  "CFG.SPARE[5]": 15,
  "CFG.MODE": 2,
  "INSTANCE0.HOURS": 123456789012,
  "INSTANCE0.STARTS": 4242,
};

describeIfGpp("retain format 2: migration by name between two real programs", () => {
  let base: Built;
  let blob: string;
  let blob1: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-retain-mig-"));
    base = build("base", program());
    blob = path.join(tempDir, "base.v2");
    blob1 = path.join(tempDir, "base.v1");
    saveFrom(base, VALUES, blob);
    saveFrom(base, VALUES, blob1, "save1");
  }, 120_000);

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("unchanged program: Ok, every value back, a STRING longer than 126 whole", () => {
    const { report, values } = loadInto(base, blob);
    expect(report).toMatchObject({ result: OK, format: 2, kept: 13, added: 0, dropped: 0, refused: 0 });
    expect(report.lastMatches).toBe(true);
    for (const [k, v] of Object.entries(VALUES)) expect(values[k]).toEqual(v);
    expect((values["CFG.NOTE"] as string).length).toBe(155);
  });

  it("strings are stored at their declared length, not the debugger's 127-byte window", () => {
    const size = fs.statSync(blob).size;
    // payload: REAL 4 + INT 2 + BOOL 1 + STRING(32) 33 + STRING(200) 201 + 5 INT 10
    //          + MODE 2 + LINT 8 + DINT 4 = 265; trailer 4 + 8 singles*6 + 1 run*12 = 64
    expect(size).toBe(14 + 265 + 64);
    expect(base.map.retainBlobSize).toBe(size);
    expect(base.map.retainFormat).toBe(2);
  });

  it("format 1 blob of the same layout still loads (strings capped at 126, as before)", () => {
    const { report, values } = loadInto(base, blob1);
    expect(report).toMatchObject({ result: OK, format: 1, kept: 13 });
    expect(values["CFG.PUMPS"]).toBe(7);
    expect(values["CFG.NOTE"]).toBe(LONG.slice(0, 126));
  });

  it("format 1 blob of another layout is refused as StaleLayout, nothing written", () => {
    const p = build("v1stale", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;
    added : REAL := 9.5;` }));
    const { report, values } = loadInto(p, blob1);
    expect(report.result).toBe(STALE);
    expect(values["CFG.PUMPS"]).toBe(2);
    expect(values["CFG.SITE"]).toBe("none");
  });

  it("add a member: every other value kept, the new one at its initial value", () => {
    const p = build("add", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    newSetting : REAL := 3.5;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;` }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, kept: 13, added: 1, dropped: 0, refused: 0 });
    for (const [k, v] of Object.entries(VALUES)) expect(values[k]).toEqual(v);
    expect(values["CFG.NEWSETTING"]).toBe(3.5);
  });

  it("remove a member: dropped, the rest kept", () => {
    const p = build("remove", program({ cfg: `
    levelHi : REAL := 1.5;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;` }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, kept: 12, added: 0, dropped: 1, refused: 0 });
    expect(values["CFG.LEVELHI"]).toBe(2.25);
    expect(values["CFG.SITE"]).toBe("Posprop effluent");
  });

  it("reorder members: all kept", () => {
    const p = build("reorder", program({ cfg: `
    site : STRING(32) := 'none';
    mode : MODE_T;
    spare : ARRAY[1..5] OF INT;
    pumps : INT := 2;
    note : STRING(200);
    enabled : BOOL;
    levelHi : REAL := 1.5;` }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, kept: 13, added: 0, dropped: 0, refused: 0 });
    for (const [k, v] of Object.entries(VALUES)) expect(values[k]).toEqual(v);
  });

  it("IEC Figure 12 conversions kept (INT->DINT, INT->REAL, REAL->LREAL, DINT->LINT); others refused", () => {
    const p = build("retype", program({
      cfg: `
    levelHi : LREAL := 1.5;
    pumps : DINT := 2;
    enabled : INT := 5;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF REAL;
    mode : MODE_T;`,
      prog: `
VAR RETAIN hours : INT := 3; starts : LINT; END_VAR`,
    }));
    const { report, values } = loadInto(p, blob);
    // converted: levelHi REAL->LREAL, pumps INT->DINT, 5x spare INT->REAL, starts DINT->LINT
    // refused:   enabled BOOL->INT (not in Figure 12), hours LINT->INT (narrowing)
    expect(report).toMatchObject({ result: MIGRATED, converted: 8, refused: 2, added: 0, dropped: 0, kept: 3 });
    expect(values["CFG.LEVELHI"]).toBe(2.25);
    expect(values["CFG.PUMPS"]).toBe(7);
    expect(values["CFG.SPARE[3]"]).toBe(13);
    expect(values["INSTANCE0.STARTS"]).toBe(4242);
    expect(values["CFG.ENABLED"]).toBe(5);
    expect(values["INSTANCE0.HOURS"]).toBe(3);
  });

  it("REAL->INT is refused: the variable keeps its initial value", () => {
    const p = build("narrow", program({ cfg: `
    levelHi : INT := 77;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;` }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, refused: 1, kept: 12 });
    expect(values["CFG.LEVELHI"]).toBe(77);
  });

  it("STRING(32) -> STRING(64) kept; STRING(32) -> STRING(7) keeps the first 7 characters", () => {
    const grow = build("strgrow", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(64) := 'none';
    note : STRING(100);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;` }));
    const g = loadInto(grow, blob);
    expect(g.report).toMatchObject({ result: MIGRATED, kept: 13, truncated: 1 });
    expect(g.values["CFG.SITE"]).toBe("Posprop effluent");
    expect(g.values["CFG.NOTE"]).toBe(LONG.slice(0, 100));
    const shrink = build("strshrink", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(7) := 'none';
    note : STRING(200);
    spare : ARRAY[1..5] OF INT;
    mode : MODE_T;` }));
    const s = loadInto(shrink, blob);
    expect(s.report).toMatchObject({ result: MIGRATED, kept: 13, truncated: 1 });
    expect(s.values["CFG.SITE"]).toBe("Posprop");
  });

  it("ARRAY[1..5] -> [1..8]: elements kept by subscript, new ones initial; -> [2..3]: the rest dropped", () => {
    const grow = build("arrgrow", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[1..8] OF INT := [8(-1)];
    mode : MODE_T;` }));
    const g = loadInto(grow, blob);
    expect(g.report).toMatchObject({ result: MIGRATED, kept: 13, added: 3, dropped: 0 });
    expect(g.values["CFG.SPARE[5]"]).toBe(15);
    expect(g.values["CFG.SPARE[6]"]).toBe(-1);
    const shrink = build("arrshrink", program({ cfg: `
    levelHi : REAL := 1.5;
    pumps : INT := 2;
    enabled : BOOL;
    site : STRING(32) := 'none';
    note : STRING(200);
    spare : ARRAY[2..3] OF INT;
    mode : MODE_T;` }));
    const s = loadInto(shrink, blob);
    expect(s.report).toMatchObject({ result: MIGRATED, kept: 10, dropped: 3 });
    expect(s.values["CFG.SPARE[2]"]).toBe(12);
    expect(s.values["CFG.SPARE[3]"]).toBe(13);
  });

  it("a renamed program instance is a different variable: reset (dropped + new)", () => {
    const p = build("rename", program({ inst: "instance1" }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, kept: 11, added: 2, dropped: 2 });
    expect(values["INSTANCE1.STARTS"]).toBe(0);
    expect(values["CFG.PUMPS"]).toBe(7);
  });

  it("a changed enumeration is a different type: its value is not carried over", () => {
    const p = build("enum", program({ enumDef: `MODE_T : (OFF, HAND, AUTO, REMOTE) := OFF;` }));
    const { report, values } = loadInto(p, blob);
    expect(report).toMatchObject({ result: MIGRATED, kept: 12, added: 1, dropped: 1 });
    expect(values["CFG.MODE"]).toBe(0);
  });

  describe("an enumeration whose members were only appended keeps its values (decision 26)", () => {
    // IEC 61131-3 6.4.4.2 / 6.4.4.3: a value of an enumerated (or named-value)
    // type is one of its listed members. Appending members leaves every stored
    // member in place with its value, so an upload (a warm restart, 6.5.6.1
    // rule 1) keeps it; any other change drops it (6.5.6.2: initial value).
    const enumProgram = (types: string) => `TYPE
  ${types}
END_TYPE
PROGRAM Main
VAR RETAIN plain : E1; small : E2; named : E3; many : ARRAY[1..3] OF E2; END_VAR
  plain := plain;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;
    const ENUM_VALUES = {
      "INSTANCE0.PLAIN": 2,
      "INSTANCE0.SMALL": 2,
      "INSTANCE0.NAMED": 20,
      "INSTANCE0.MANY[1]": 1,
      "INSTANCE0.MANY[2]": 2,
      "INSTANCE0.MANY[3]": 0,
    };
    let saved: string;
    beforeAll(() => {
      const p = build("enum-base", enumProgram(`E1 : (A1, B1, C1);
  E2 : USINT (A2, B2, C2);
  E3 : UINT (X3 := 10, Y3 := 20);`));
      saved = path.join(tempDir, "enum-base.v2");
      saveFrom(p, ENUM_VALUES, saved);
    }, 120_000);

    it("plain, USINT-based and UINT named-value enumerations, members appended: every value kept", () => {
      const p = build("enum-append", enumProgram(`E1 : (A1, B1, C1, D1);
  E2 : USINT (A2, B2, C2, D2, E2X);
  E3 : UINT (X3 := 10, Y3 := 20, Z3 := 30);`));
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 6, added: 0, dropped: 0, refused: 0 });
      for (const [k, v] of Object.entries(ENUM_VALUES)) expect(values[k]).toEqual(v);
    });

    it("unchanged enumerations: Ok", () => {
      const p = build("enum-same", enumProgram(`E1 : (A1, B1, C1);
  E2 : USINT (A2, B2, C2);
  E3 : UINT (X3 := 10, Y3 := 20);`));
      expect(loadInto(p, saved).report).toMatchObject({ result: OK, kept: 6 });
    });

    it("reorder, rename, removal or a changed value: dropped, initial value", () => {
      const p = build("enum-other", enumProgram(`E1 : (B1, A1, C1, D1);
  E2 : USINT (A2, B2, CC2) := B2;
  E3 : UINT (X3 := 10) := X3;`));
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 0, added: 6, dropped: 6 });
      expect(values["INSTANCE0.PLAIN"]).toBe(0);
      expect(values["INSTANCE0.SMALL"]).toBe(1);
      expect(values["INSTANCE0.NAMED"]).toBe(10);
      const v = build("enum-value", enumProgram(`E1 : (A1, B1, C1);
  E2 : USINT (A2, B2, C2);
  E3 : UINT (X3 := 10, Y3 := 21, Z3 := 30) := X3;`));
      const r = loadInto(v, saved);
      expect(r.report).toMatchObject({ result: MIGRATED, kept: 5, added: 1, dropped: 1 });
      expect(r.values["INSTANCE0.NAMED"]).toBe(10);
    });

    it("an enumeration that lost its last members is not a start of the stored one: dropped", () => {
      const p = build("enum-shorter", enumProgram(`E1 : (A1, B1);
  E2 : USINT (A2, B2, C2);
  E3 : UINT (X3 := 10, Y3 := 20);`));
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 5, added: 1, dropped: 1 });
      expect(values["INSTANCE0.PLAIN"]).toBe(0);
    });
  });

  describe("library blocks in a RETAIN array: resize, enumeration growth, NON_RETAIN", () => {
    // T12: a retained element is named by its own subscript and member, so a
    // resized array keeps every element whose subscript still exists; new ones
    // start from their initial values (6.5.6.2), removed ones are dropped.
    const lib = (members: string): StlibArchive => {
      const r = compileStlib(
        [
          {
            fileName: "lt.st",
            source: `TYPE LT_MODE : USINT (${members}) := LT_OFF; END_TYPE
FUNCTION_BLOCK LT_ZONE
VAR_INPUT NON_RETAIN Cmd : INT; END_VAR
VAR_INPUT Sp : REAL := 1.5; END_VAR
VAR Mode : LT_MODE; Runs : DINT; Hist : ARRAY[1..2] OF INT; END_VAR
VAR NON_RETAIN Scratch : INT; END_VAR
Runs := Runs + 1;
END_FUNCTION_BLOCK
`,
          },
        ],
        { name: "lt-lib", version: "1.0.0", namespace: "lt" },
      );
      expect(r.errors).toEqual([]);
      return loadStlibFromString(JSON.stringify(r.archive));
    };
    const zones = (range: string) => `PROGRAM Main
VAR RETAIN z : ARRAY[${range}] OF LT_ZONE; END_VAR
  z[1](Sp := z[1].Sp);
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;
    const ZONE_VALUES: Record<string, number> = {};
    for (const n of [1, 2, 3, 4]) {
      ZONE_VALUES[`INSTANCE0.Z[${n}].SP`] = 10 + n;
      ZONE_VALUES[`INSTANCE0.Z[${n}].MODE`] = 1;
      ZONE_VALUES[`INSTANCE0.Z[${n}].RUNS`] = 100 * n;
      ZONE_VALUES[`INSTANCE0.Z[${n}].HIST[2]`] = n;
    }
    let base: Built;
    let saved: string;
    beforeAll(() => {
      base = build("zones-4", zones("1..4"), [lib("LT_OFF, LT_AUTO")]);
      saved = path.join(tempDir, "zones-4.v2");
      saveFrom(base, ZONE_VALUES, saved);
    }, 120_000);

    it("a block's NON_RETAIN members stay out of a RETAIN instance (6.5.6.2)", () => {
      const paths = base.retained.map((l) => l.path);
      expect(paths).toContain("INSTANCE0.Z[1].SP");
      expect(paths).toContain("INSTANCE0.Z[1].RUNS");
      expect(paths.filter((p) => /SCRATCH|CMD/.test(p))).toEqual([]);
      // 4 zones x (Sp, Mode, Runs, Hist[1], Hist[2])
      expect(paths.length).toBe(20);
    });

    it("[1..4] -> [1..5]: the four zones kept, the fifth at its initial values", () => {
      const p = build("zones-5", zones("1..5"), [lib("LT_OFF, LT_AUTO")]);
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 20, added: 5, dropped: 0 });
      for (const [k, v] of Object.entries(ZONE_VALUES)) expect(values[k]).toEqual(v);
      expect(values["INSTANCE0.Z[5].SP"]).toBe(1.5);
      expect(values["INSTANCE0.Z[5].RUNS"]).toBe(0);
    });

    it("[1..4] -> [1..3]: three zones kept, the fourth dropped", () => {
      const p = build("zones-3", zones("1..3"), [lib("LT_OFF, LT_AUTO")]);
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 15, added: 0, dropped: 5 });
      expect(values["INSTANCE0.Z[3].RUNS"]).toBe(300);
      expect(values["INSTANCE0.Z[3].MODE"]).toBe(1);
    });

    it("a resize together with a library enumeration that gained a member: all kept", () => {
      const p = build("zones-5-hand", zones("1..5"), [lib("LT_OFF, LT_AUTO, LT_HAND")]);
      const { report, values } = loadInto(p, saved);
      expect(report).toMatchObject({ result: MIGRATED, kept: 20, added: 5, dropped: 0 });
      for (const n of [1, 2, 3, 4]) expect(values[`INSTANCE0.Z[${n}].MODE`]).toBe(1);
    });
  });

  describe("safety: a damaged blob writes nothing", () => {
    const damage = (name: string, fn: (b: Buffer) => Buffer, recrc: boolean) => {
      const b = fn(Buffer.from(fs.readFileSync(blob)));
      if (recrc) {
        const payload = b.readUInt16LE(8);
        const tl = b.length >= 14 + payload + 2 ? b.readUInt16LE(14 + payload) : 0;
        const end = Math.min(b.length, 14 + payload + tl);
        let c = 0xffffffff;
        const feed = (x: Buffer) => { for (const byte of x) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } };
        feed(b.subarray(0, 10));
        feed(b.subarray(14, end));
        b.writeUInt32LE((c ^ 0xffffffff) >>> 0, 10);
      }
      const f = path.join(tempDir, `bad-${name}`);
      fs.writeFileSync(f, b);
      return f;
    };
    const untouched = (values: Record<string, unknown>) => {
      expect(values["CFG.PUMPS"]).toBe(2);
      expect(values["CFG.SITE"]).toBe("none");
      expect(values["INSTANCE0.STARTS"]).toBe(0);
    };
    it.each([
      ["payload bit flip", (b: Buffer) => { b[20] ^= 0x10; return b; }, false, BAD_CRC],
      ["trailer bit flip", (b: Buffer) => { b[b.length - 3] ^= 0x10; return b; }, false, BAD_CRC],
      ["cut short", (b: Buffer) => b.subarray(0, b.length - 5), false, TRUNCATED],
      ["header only", (b: Buffer) => b.subarray(0, 14), false, TRUNCATED],
      ["unknown tag", (b: Buffer) => { b[14 + b.readUInt16LE(8) + 4 + 4] = 0x3f; return b; }, true, BAD_TRAILER],
      ["entry count wrong", (b: Buffer) => { const t = 14 + b.readUInt16LE(8); b.writeUInt16LE(b.readUInt16LE(t + 2) + 1, t + 2); return b; }, true, BAD_TRAILER],
      ["declared length changed (widths no longer sum)", (b: Buffer) => { const t = 14 + b.readUInt16LE(8); b[t + 4 + 6 * 3 + 5] = 31; return b; }, true, BAD_TRAILER],
      ["trailer length short", (b: Buffer) => { const t = 14 + b.readUInt16LE(8); b.writeUInt16LE(b.readUInt16LE(t) - 6, t); return b; }, true, BAD_TRAILER],
    ])("%s", (name, fn, recrc, expected) => {
      const { report, values } = loadInto(base, damage(name as string, fn as (b: Buffer) => Buffer, recrc as boolean));
      expect(report.result).toBe(expected);
      untouched(values);
    });
  });
});
