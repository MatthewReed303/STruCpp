// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime — retain-variable marshalling.
 *
 * One implementation of the blob format and the pack/unpack walk, shared by
 * every host. Both the Arduino firmware and the OpenPLC v4 daemon already
 * vendor this directory, so neither writes packing code of its own and the two
 * cannot drift: a blob written by a firmware is readable by a daemon built from
 * the same compiler.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not storage, and it decides nothing about persistence. It turns the
 * retained leaves into a byte array and back. Where those bytes live — EEPROM,
 * NVS, FRAM, battery-backed SRAM, a file — and how often they are written is
 * entirely the platform driver's business.
 *
 * WHY (arr, elem) AND NOT AN OFFSET
 * ---------------------------------
 * An earlier design described each retained variable as
 * `{ name, offsetof(Class, member), sizeof(IECVar<T>) }`. Three things were
 * wrong with it, and all three go away here:
 *
 *   - `sizeof(IECVar<T>)` is the whole wrapper. A DINT measures 12 bytes, not
 *     4, and the extra bytes are `forced_` and `forced_value_` — so persisting
 *     that region carried the debugger's forcing state across a power cycle.
 *     Here every value moves through `handle_read` / `handle_write`, which
 *     touch the value and nothing else.
 *   - `offsetof` on a program class is `offsetof` on a non-standard-layout type
 *     (it derives from ProgramBase and has virtuals) — conditionally supported,
 *     and it warns.
 *   - It could only describe members of a PROGRAM. A retained variable inside a
 *     nested function block, or a retained CONFIGURATION global, had no
 *     representation at all. Leaf indices already cover both.
 *
 * ORDER IS THE CONTRACT. `retain_vars[]` is emitted in the codegen's leaf-walk
 * order and the payload packs values in exactly that order, so the blob needs
 * no per-entry addressing. `retain_layout_hash` is what makes that safe: it
 * changes when the ordered set of retained leaves changes, and a blob whose
 * hash disagrees is refused rather than unpacked into the wrong variables.
 *
 * TWO FORMATS. Format 1 (just below) is what every program wrote before
 * migration by name; it is still READ, so a blob saved by an older build of the
 * same layout restores, and the legacy blob_size/pack/unpack stay for hosts
 * built against them. Format 2 (end of this file: blob_size2/pack2/unpack2)
 * is what is written now: exact-width values plus a descriptor trailer naming
 * every value, so a changed program keeps every value whose variable still
 * exists (IEC 61131-3 6.5.6.1 rule 1).
 *
 * WIDTHS COME FROM THE RUNTIME, NEVER FROM A MANIFEST. (Format 1.) `size_of(arr, elem)`
 * reports what the debug transport actually moves for that leaf, which is not
 * the declared width: a STRING is a fixed 127 bytes regardless of `STRING(20)`.
 * Sizing the payload from anything else desynchronises it from what the target
 * can read and write.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "debug_table.hpp"
#include "iec_types.hpp"

namespace strucpp {
namespace retain {

// =============================================================================
// Blob format
// =============================================================================
//
//   off  size  field
//   ---  ----  -----------------------------------------------------------
//     0     2  magic         0x4F52 ('O','R'), little-endian
//     2     1  format        FORMAT_VERSION
//     3     1  flags         reserved, must be 0
//     4     4  layout_hash   strucpp::debug::retain_layout_hash
//     8     2  payload_len   packed value bytes that follow
//    10     4  crc32         over bytes [0,10) + payload
//   ---  ----  -----------------------------------------------------------
//    14     N  payload       values in retain_vars[] order, natural width,
//                            no padding and no per-entry addressing
//
// Fourteen bytes of overhead, once. Everything after it is payload — no paths,
// no indices, no type tags. The mapping from byte range to variable lives in
// the compiled program, where storage is free, and not in the retain region,
// where it is scarce: a 4 KB EEPROM holds around a thousand retained DINTs.

constexpr uint16_t MAGIC          = 0x4F52;
constexpr uint8_t  FORMAT_VERSION = 1;
constexpr uint16_t HEADER_SIZE    = 14;

/** Outcome of a load. Anything other than `Ok` leaves every variable at its
 *  declared initial value, which is the correct cold-start behaviour. */
enum class LoadResult : uint8_t {
    Ok = 0,
    /** Nothing stored yet, or the store was cleared. First boot looks like this. */
    Empty,
    /** Not a retain blob (or a torn write that lost the header). */
    BadMagic,
    /** Written by a different format version. */
    BadFormat,
    /** Header and payload disagree — a torn or corrupted write. */
    BadCrc,
    /** Written by a program whose retained variables differ. Refused, not
     *  unpacked: the bytes would land in the wrong variables. */
    StaleLayout,
    /** Payload shorter than this program's retained leaves need. */
    Truncated,
    /** Format 2, written by a program whose retained variables differ: every
     *  value whose variable still exists was restored BY NAME (unpack2 only). */
    Migrated,
    /** Format 2 whose descriptor trailer does not describe its payload. Refused
     *  as a whole: nothing is written. */
    BadTrailer,
};

// -----------------------------------------------------------------------------
// Host-supplied leaf accessors.
//
// Function pointers, so one implementation serves both hosts. The Arduino glue
// passes `strucpp::debug::handle_*` directly. The v4 daemon passes its dlsym'd
// thunks — and for the write it passes the path that routes a LOCATED leaf
// through the image journal, because poking such a leaf's IECVar directly is
// undone by the next copy-in from the process image.
// -----------------------------------------------------------------------------

/** Read one leaf's value. Returns bytes written, 0 on failure. */
using ReadLeaf = uint16_t (*)(uint8_t arr, uint16_t elem, uint8_t* dest);

/** Write one leaf's value. Must be a plain write — NEVER a force. Restoring a
 *  retained value must not pin it: the program has to be able to move it on the
 *  very next scan, and an operator's force must stay authoritative. */
using WriteLeaf = uint8_t (*)(uint8_t arr, uint16_t elem, const uint8_t* bytes, uint16_t len);

/** Bytes this leaf occupies on the debug transport. */
using SizeLeaf = uint16_t (*)(uint8_t arr, uint16_t elem);

// =============================================================================
// crc32
// =============================================================================

/**
 * Bitwise CRC-32 (IEEE 802.3, reflected). No lookup table on purpose: a 1 KB
 * table is real money on a 2 KB-SRAM part, and this runs once per save over a
 * blob measured in tens or hundreds of bytes.
 */
inline uint32_t crc32(const uint8_t* data, size_t len, uint32_t seed = 0xFFFFFFFFu) noexcept {
    uint32_t crc = seed;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
        for (uint8_t bit = 0; bit < 8; ++bit) {
            crc = (crc & 1u) ? ((crc >> 1) ^ 0xEDB88320u) : (crc >> 1);
        }
    }
    return crc;
}

// =============================================================================
// Little-endian field access
// =============================================================================
//
// Explicit byte-at-a-time, not a struct cast: the blob may be handed over
// unaligned (a driver's read buffer, an offset into a flash page), and AVR and
// ARM disagree about what that costs. Little-endian is fixed by the format so a
// blob stays portable between a target and a host-side tool.

inline void put_u16(uint8_t* p, uint16_t v) noexcept {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
}

inline void put_u32(uint8_t* p, uint32_t v) noexcept {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
    p[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
    p[3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline uint16_t get_u16(const uint8_t* p) noexcept {
    return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                                 static_cast<uint16_t>(static_cast<uint16_t>(p[1]) << 8));
}

inline uint32_t get_u32(const uint8_t* p) noexcept {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

// =============================================================================
// Sizing
// =============================================================================

/** Packed payload size for this program's retained leaves. */
inline size_t payload_size(SizeLeaf size_of) noexcept {
    size_t total = 0;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        total += size_of(debug::retain_vars[i].arr, debug::retain_vars[i].elem);
    }
    return total;
}

/**
 * Total blob size, header included. Zero when nothing is retained — a host can
 * use that to skip the whole path, and a driver to skip provisioning storage.
 */
inline size_t blob_size(SizeLeaf size_of) noexcept {
    if (debug::retain_var_count == 0) return 0;
    return HEADER_SIZE + payload_size(size_of);
}

// =============================================================================
// Pack
// =============================================================================

/**
 * Serialise every retained leaf into `out`.
 *
 * Returns bytes written, or 0 if `cap` is too small or nothing is retained.
 * Allocation-free and safe to call from a scan-cycle context: a bounded walk
 * plus one crc pass.
 */
inline size_t pack(uint8_t* out, size_t cap, ReadLeaf read_leaf, SizeLeaf size_of) noexcept {
    if (debug::retain_var_count == 0) return 0;

    const size_t payload = payload_size(size_of);
    const size_t total   = static_cast<size_t>(HEADER_SIZE) + payload;
    if (out == nullptr || cap < total) return 0;

    size_t at = HEADER_SIZE;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        const uint8_t  arr   = debug::retain_vars[i].arr;
        const uint16_t elem  = debug::retain_vars[i].elem;
        const uint16_t width = size_of(arr, elem);
        if (width == 0) continue;
        // A short read leaves that leaf's bytes zeroed rather than aborting the
        // whole save: one unreadable leaf must not cost every other retained
        // value in the blob.
        if (read_leaf(arr, elem, out + at) != width) {
            memset(out + at, 0, width);
        }
        at += width;
    }

    put_u16(out + 0, MAGIC);
    out[2] = FORMAT_VERSION;
    out[3] = 0;  // flags, reserved
    put_u32(out + 4, debug::retain_layout_hash);
    put_u16(out + 8, static_cast<uint16_t>(payload));
    // crc covers the header so far plus the payload; the crc field itself
    // (offset 10..13) is excluded, which is why it sits last in the header.
    uint32_t crc = crc32(out, 10);
    crc          = crc32(out + HEADER_SIZE, payload, crc);
    put_u32(out + 10, crc ^ 0xFFFFFFFFu);

    return total;
}

// =============================================================================
// Unpack
// =============================================================================

/**
 * Restore every retained leaf from `blob`.
 *
 * Validates before writing anything, so a corrupt or stale store degrades to a
 * cold start rather than to plausible-looking garbage in a running machine.
 *
 * `write_leaf` must be a plain write. See {@link WriteLeaf}.
 */
inline LoadResult unpack(const uint8_t* blob,
                         size_t          len,
                         WriteLeaf       write_leaf,
                         SizeLeaf        size_of) noexcept {
    if (debug::retain_var_count == 0) return LoadResult::Ok;  // nothing to do
    if (blob == nullptr || len == 0) return LoadResult::Empty;
    if (len < HEADER_SIZE) return LoadResult::Truncated;

    if (get_u16(blob) != MAGIC) return LoadResult::BadMagic;
    if (blob[2] != FORMAT_VERSION) return LoadResult::BadFormat;

    const uint16_t payload = get_u16(blob + 8);
    // `len - HEADER_SIZE`, not `HEADER_SIZE + payload`: `len` is already known
    // >= HEADER_SIZE above, so the subtraction can't underflow, but the addition
    // can overflow on a 16-bit size_t (avr-gcc) when `payload` is corrupted
    // close to 65535 — which would wrap this check to true and let the crc32
    // call below read tens of KB past `blob`.
    if (len - HEADER_SIZE < payload) return LoadResult::Truncated;

    uint32_t crc = crc32(blob, 10);
    crc          = crc32(blob + HEADER_SIZE, payload, crc);
    if ((crc ^ 0xFFFFFFFFu) != get_u32(blob + 10)) return LoadResult::BadCrc;

    // Checked AFTER the crc: a stale-layout answer only means something once
    // the bytes are known to be intact, and reporting StaleLayout for a torn
    // write would send someone looking for a program change that never
    // happened.
    if (get_u32(blob + 4) != debug::retain_layout_hash) return LoadResult::StaleLayout;

    if (payload != payload_size(size_of)) return LoadResult::Truncated;

    size_t at = HEADER_SIZE;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        const uint8_t  arr   = debug::retain_vars[i].arr;
        const uint16_t elem  = debug::retain_vars[i].elem;
        const uint16_t width = size_of(arr, elem);
        if (width == 0) continue;
        // A refused write is tolerated, not fatal: a leaf that became read-only
        // (declared CONSTANT since, with the layout otherwise unchanged) must
        // not stop the remaining values from being restored.
        write_leaf(arr, elem, blob + at, width);
        at += width;
    }
    return LoadResult::Ok;
}

// =============================================================================
// Format 2: exact-width values plus a descriptor trailer — migration by name
// =============================================================================
//
// WHY. Format 1 packs values in leaf order with nothing else, so a program whose
// retained declarations changed in any way — one member added to a RETAIN
// struct — could only refuse the whole blob, and every setting, total and run
// hour on a site went back to its initial value on the next upload. IEC
// 61131-3 does not ask for that. 6.5.6.1 rule 1 (p.57) gives a RETAIN variable
// "the values the variables had when the resource or configuration was
// stopped" on a warm restart, and Part 3 says nothing about downloads (4.1,
// p.19, defines loading only). So a variable that still exists keeps its value;
// one that is new has no retained value and is initialized (6.5.6.2, p.57) —
// which here means it is simply not written; one that is gone is dropped.
//
//   off  size  field
//   ---  ----  -----------------------------------------------------------
//     0     2  magic         0x4F52, little-endian
//     2     1  format        2
//     3     1  flags         0
//     4     4  layout_hash   retain_layout_hash (format-1 definition; logged)
//     8     2  payload_len
//    10     4  crc32         over [0,10) and [14, 14 + payload_len + trailer_len)
//    14     N  payload       retain_leaves[] order, EXACT widths:
//                              scalar   its native little-endian width
//                              STRING   [len u8][C bytes]       C = declared length
//                              WSTRING  [len u8][C code units, LE]
//   14+N    T  trailer       u16 trailer_len (whole trailer), u16 entry_count,
//                            then per entry, in payload order:
//                              single  u32 id, u8 tag,        u8 cap          6 bytes
//                              run     u32 id, u8 tag | 0x80, u8 cap,
//                                      i32 first, u16 count                  12 bytes
//
// A run is `count` consecutive elements of one innermost array of scalars
// (same id, tag and cap, subscripts first, first+1, ...): a retained
// ARRAY[1..4000] OF BOOL costs 12 bytes of trailer, not 24 000.
//
// Strings are stored at their declared length, not at the debugger's 127-byte
// window: a STRING(32) costs 33 bytes instead of 127, and a STRING(200) keeps
// all 200 characters instead of the first 126.
//
// TYPE RULES, stored -> new, per variable:
//   same type                       restored (STRING(n) -> STRING(m) keeps the
//                                   first m characters when it no longer fits:
//                                   6.6.1.2.2, p.58, leaves a longer source
//                                   Implementer specific, and this is what
//                                   STruC++ assignment does)
//   an IEC Figure 12 implicit       converted. 6.6.1.6 (p.66) rule 1: implicit
//   conversion (p.68)               conversion "shall keep the value and
//                                   accuracy of the data types"
//   anything else                   refused: the variable keeps its initial
//                                   value. No narrowing, no REAL -> INT, no
//                                   STRING <-> WSTRING (Figure 11 NOTE).
// An enumerated or subrange type's definition is part of the leaf's identity
// (debug_table.hpp), so changing it gives a new variable, never a number
// re-read with another meaning.
//
// SAFETY. Everything is validated — magic, format, lengths, crc, every trailer
// entry and the payload widths it implies — before the first value is written.
// A blob that fails any check writes nothing.

constexpr uint8_t  FORMAT_V1        = 1;
constexpr uint8_t  FORMAT_V2        = 2;
constexpr uint8_t  TRAILER_RUN_FLAG = 0x80;
constexpr uint16_t TRAILER_HEADER   = 4;
constexpr uint16_t ENTRY_SINGLE     = 6;
constexpr uint16_t ENTRY_RUN        = 12;
/** Every length in the blob and in the store interface is 16-bit. */
constexpr size_t   BLOB_MAX         = 65535;

/** The host's flash-safe reader of retained leaf `i` (debug::handle_retain_leaf). */
using LeafAt = bool (*)(uint16_t i, debug::RetainLeafInfo* out);

/** A string leaf's whole content: characters, or LE code units. Returns bytes. */
using ReadText = uint16_t (*)(uint8_t arr, uint16_t elem, uint8_t* dest, uint16_t cap_bytes);

/** Store a string leaf's content (plain write, truncating). 0x7E on success. */
using WriteText = uint8_t (*)(uint8_t arr, uint16_t elem, const uint8_t* src, uint16_t nbytes);

/** The status a host's write callbacks return on success (debug STATUS_OK). */
constexpr uint8_t WRITE_OK = 0x7E;

/** What a host lends the format-2 walk. All six are required. */
struct Host {
    LeafAt    leaf;        // debug::handle_retain_leaf
    ReadLeaf  read;        // scalar value, native width (debug::handle_read)
    WriteLeaf write;       // scalar plain write — NEVER a force
    ReadText  read_text;   // debug::handle_read_text
    WriteText write_text;  // debug::handle_write_text
    SizeLeaf  wire_size;   // debug::handle_size: restores a FORMAT-1 blob only
};

/**
 * What the last restore did. Plain data, 24 bytes on every target, so the
 * OpenPLC v4 runtime can mirror it as a C struct and log it, and a firmware can
 * show it. `kept` includes `truncated`.
 */
struct Report {
    uint8_t  result;          // LoadResult
    uint8_t  format;          // the stored blob's format, 0 when none
    uint16_t kept;            // restored with its own type
    uint16_t converted;       // restored through a Figure 12 conversion
    uint16_t truncated;       // strings shortened to a smaller declared length
    uint16_t added;           // no stored value: the initial value stands
    uint16_t dropped;         // stored values whose variable no longer exists
    uint16_t refused;         // a stored value the variable cannot take
    uint16_t reserved;        // 0
    uint32_t stored_layout;   // layout_hash in the stored header
    uint32_t program_layout;  // this program's retain_layout_hash
};
static_assert(sizeof(Report) == 24, "Report is mirrored byte for byte by the OpenPLC runtime");

/** The last unpack2() outcome, in the program image itself: any host, block
 *  or diagnostic can read it without a runtime-specific channel. */
inline Report& last_report() noexcept {
    static Report report = {};
    return report;
}

/** The declared length of a string leaf: 0 in the tables means the default. */
inline uint16_t text_capacity(uint8_t cap) noexcept { return cap == 0 ? 254u : cap; }

/** Bytes a leaf occupies in a format-2 payload; 0 for a tag this build does not know. */
inline uint32_t leaf_width(uint8_t tag, uint8_t cap) noexcept {
    switch (tag) {
        case debug::TAG_BOOL:    return sizeof(BOOL_t);
        case debug::TAG_SINT:    return sizeof(SINT_t);
        case debug::TAG_USINT:   return sizeof(USINT_t);
        case debug::TAG_INT:     return sizeof(INT_t);
        case debug::TAG_UINT:    return sizeof(UINT_t);
        case debug::TAG_DINT:    return sizeof(DINT_t);
        case debug::TAG_UDINT:   return sizeof(UDINT_t);
        case debug::TAG_LINT:    return sizeof(LINT_t);
        case debug::TAG_ULINT:   return sizeof(ULINT_t);
        case debug::TAG_REAL:    return sizeof(REAL_t);
        case debug::TAG_LREAL:   return sizeof(LREAL_t);
        case debug::TAG_BYTE:    return sizeof(BYTE_t);
        case debug::TAG_WORD:    return sizeof(WORD_t);
        case debug::TAG_DWORD:   return sizeof(DWORD_t);
        case debug::TAG_LWORD:   return sizeof(LWORD_t);
        case debug::TAG_TIME:    return sizeof(TIME_t);
        case debug::TAG_DATE:    return sizeof(DATE_t);
        case debug::TAG_TOD:     return sizeof(TOD_t);
        case debug::TAG_DT:      return sizeof(DT_t);
        case debug::TAG_STRING:  return 1u + text_capacity(cap);
        case debug::TAG_WSTRING: return 1u + 2u * text_capacity(cap);
        default:                 return 0;
    }
}

inline bool is_text(uint8_t tag) noexcept {
    return tag == debug::TAG_STRING || tag == debug::TAG_WSTRING;
}

// -----------------------------------------------------------------------------
// IEC 61131-3 Figure 12 (p.68), the supported implicit conversions, closed
// under composition (INT -> REAL -> LREAL is INT -> LREAL). One bit per target
// tag. TIME/LTIME, DT/LDT, DATE/LDATE and TOD/LTOD share a tag here, so those
// arrows are "same type". CHAR -> STRING and WCHAR -> WSTRING have no CHAR leaf
// to start from.
// -----------------------------------------------------------------------------
#define STRUCPP_RETAIN_BIT(t) (uint32_t{1} << debug::t)
inline uint32_t implicit_targets(uint8_t from) noexcept {
    switch (from) {
        case debug::TAG_BOOL:  return STRUCPP_RETAIN_BIT(TAG_BYTE) | STRUCPP_RETAIN_BIT(TAG_WORD) |
                                      STRUCPP_RETAIN_BIT(TAG_DWORD) | STRUCPP_RETAIN_BIT(TAG_LWORD);
        case debug::TAG_BYTE:  return STRUCPP_RETAIN_BIT(TAG_WORD) | STRUCPP_RETAIN_BIT(TAG_DWORD) |
                                      STRUCPP_RETAIN_BIT(TAG_LWORD);
        case debug::TAG_WORD:  return STRUCPP_RETAIN_BIT(TAG_DWORD) | STRUCPP_RETAIN_BIT(TAG_LWORD);
        case debug::TAG_DWORD: return STRUCPP_RETAIN_BIT(TAG_LWORD);
        case debug::TAG_SINT:  return STRUCPP_RETAIN_BIT(TAG_INT) | STRUCPP_RETAIN_BIT(TAG_DINT) |
                                      STRUCPP_RETAIN_BIT(TAG_LINT) | STRUCPP_RETAIN_BIT(TAG_REAL) |
                                      STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_INT:   return STRUCPP_RETAIN_BIT(TAG_DINT) | STRUCPP_RETAIN_BIT(TAG_LINT) |
                                      STRUCPP_RETAIN_BIT(TAG_REAL) | STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_DINT:  return STRUCPP_RETAIN_BIT(TAG_LINT) | STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_REAL:  return STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_USINT: return STRUCPP_RETAIN_BIT(TAG_INT) | STRUCPP_RETAIN_BIT(TAG_UINT) |
                                      STRUCPP_RETAIN_BIT(TAG_DINT) | STRUCPP_RETAIN_BIT(TAG_UDINT) |
                                      STRUCPP_RETAIN_BIT(TAG_LINT) | STRUCPP_RETAIN_BIT(TAG_ULINT) |
                                      STRUCPP_RETAIN_BIT(TAG_REAL) | STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_UINT:  return STRUCPP_RETAIN_BIT(TAG_DINT) | STRUCPP_RETAIN_BIT(TAG_UDINT) |
                                      STRUCPP_RETAIN_BIT(TAG_LINT) | STRUCPP_RETAIN_BIT(TAG_ULINT) |
                                      STRUCPP_RETAIN_BIT(TAG_REAL) | STRUCPP_RETAIN_BIT(TAG_LREAL);
        case debug::TAG_UDINT: return STRUCPP_RETAIN_BIT(TAG_LINT) | STRUCPP_RETAIN_BIT(TAG_ULINT) |
                                      STRUCPP_RETAIN_BIT(TAG_LREAL);
        default:               return 0;
    }
}
#undef STRUCPP_RETAIN_BIT

inline bool implicitly_convertible(uint8_t from, uint8_t to) noexcept {
    return to < 32 && (implicit_targets(from) & (uint32_t{1} << to)) != 0;
}

inline bool is_signed_int(uint8_t tag) noexcept {
    return tag == debug::TAG_SINT || tag == debug::TAG_INT || tag == debug::TAG_DINT ||
           tag == debug::TAG_LINT;
}

/**
 * Convert one stored value along an implicit conversion. Only called for a
 * pair implicitly_convertible() accepts, every one of which keeps the value.
 * Writes leaf_width(to) bytes to `out` (at most 8).
 */
inline void convert_value(uint8_t from, const uint8_t* src, uint8_t to, uint8_t* out) noexcept {
    const uint32_t from_w = leaf_width(from, 0);
    uint64_t raw = 0;
    for (uint32_t i = 0; i < from_w && i < 8; ++i) raw |= static_cast<uint64_t>(src[i]) << (8 * i);
    int64_t  s = 0;
    uint64_t u = raw;
    if (is_signed_int(from)) {
        const uint32_t bits = from_w * 8;
        s = bits >= 64 ? static_cast<int64_t>(raw)
                       : static_cast<int64_t>(raw << (64 - bits)) >> (64 - bits);
    }
    if (to == debug::TAG_REAL || to == debug::TAG_LREAL) {
        LREAL_t value = 0;
        if (from == debug::TAG_REAL) {
            REAL_t f;
            memcpy(&f, src, sizeof f);
            value = static_cast<LREAL_t>(f);
        } else if (is_signed_int(from)) {
            value = static_cast<LREAL_t>(s);
        } else {
            value = static_cast<LREAL_t>(u);
        }
        if (to == debug::TAG_REAL) {
            const REAL_t f = static_cast<REAL_t>(value);
            memcpy(out, &f, sizeof f);
        } else {
            memcpy(out, &value, sizeof value);
        }
        return;
    }
    const uint64_t bits = is_signed_int(from) ? static_cast<uint64_t>(s) : u;
    const uint32_t to_w = leaf_width(to, 0);
    for (uint32_t i = 0; i < to_w && i < 8; ++i) out[i] = static_cast<uint8_t>(bits >> (8 * i));
}

// -----------------------------------------------------------------------------
// Sizing and the trailer
// -----------------------------------------------------------------------------

namespace detail {

/** Walks the program's leaves once, as trailer entries (runs folded). */
struct EntryCursor {
    uint8_t  tag   = 0;
    uint8_t  cap   = 0;
    uint32_t id    = 0;
    int32_t  first = 0;
    uint16_t count = 0;
    bool     run   = false;
    bool     open  = false;

    /** Whether leaf `l` extends the open entry. */
    bool extends(const debug::RetainLeafInfo& l) const noexcept {
        return open && run && l.index != debug::RETAIN_NO_INDEX && l.id == id && l.tag == tag &&
               l.cap == cap && count < 0xFFFFu &&
               static_cast<int64_t>(l.index) == static_cast<int64_t>(first) + count;
    }
};

}  // namespace detail

/** Payload and trailer bytes of this program's format-2 blob. */
inline void layout2(const Host& host, uint32_t* payload, uint32_t* trailer) noexcept {
    uint32_t p = 0, t = TRAILER_HEADER;
    detail::EntryCursor e;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        debug::RetainLeafInfo l;
        if (!host.leaf(i, &l)) break;
        p += leaf_width(l.tag, l.cap);
        if (e.extends(l)) {
            ++e.count;
            continue;
        }
        e.open = true;
        e.run = l.index != debug::RETAIN_NO_INDEX;
        e.id = l.id;
        e.tag = l.tag;
        e.cap = l.cap;
        e.first = l.index;
        e.count = 1;
        t += e.run ? ENTRY_RUN : ENTRY_SINGLE;
    }
    *payload = p;
    *trailer = t;
}

/**
 * Total format-2 blob size, header and trailer included; 0 when nothing is
 * retained. May exceed BLOB_MAX, which a host must refuse (the store interface
 * carries 16-bit lengths) rather than truncate.
 */
inline size_t blob_size2(const Host& host) noexcept {
    if (debug::retain_var_count == 0) return 0;
    uint32_t p = 0, t = 0;
    layout2(host, &p, &t);
    return static_cast<size_t>(HEADER_SIZE) + p + t;
}

/**
 * Serialise every retained leaf as a format-2 blob. Returns bytes written, or 0
 * if nothing is retained, `cap` is too small, or the blob would exceed BLOB_MAX.
 * Allocation-free; safe from a scan-cycle context.
 */
inline size_t pack2(uint8_t* out, size_t cap, const Host& host) noexcept {
    if (debug::retain_var_count == 0 || out == nullptr) return 0;
    uint32_t payload = 0, trailer = 0;
    layout2(host, &payload, &trailer);
    const size_t total = static_cast<size_t>(HEADER_SIZE) + payload + trailer;
    if (total > BLOB_MAX || cap < total) return 0;

    // Payload.
    size_t at = HEADER_SIZE;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        debug::RetainLeafInfo l;
        if (!host.leaf(i, &l)) return 0;
        const uint32_t w = leaf_width(l.tag, l.cap);
        uint8_t* slot = out + at;
        if (is_text(l.tag)) {
            const uint16_t room = static_cast<uint16_t>(w - 1u);
            uint16_t n = host.read_text(l.arr, l.elem, slot + 1, room);
            if (n > room) n = room;
            if (l.tag == debug::TAG_WSTRING) n &= static_cast<uint16_t>(~1u);
            slot[0] = static_cast<uint8_t>(l.tag == debug::TAG_WSTRING ? n / 2u : n);
            memset(slot + 1 + n, 0, room - n);
        } else if (host.read(l.arr, l.elem, slot) != w) {
            // One unreadable leaf costs its own value, not every other one.
            memset(slot, 0, w);
        }
        at += w;
    }

    // Trailer: entries first, then its two header fields once the count is known.
    const size_t trailer_at = at;
    at += TRAILER_HEADER;
    uint16_t entries = 0;
    uint8_t* count_field = nullptr;
    detail::EntryCursor e;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        debug::RetainLeafInfo l;
        if (!host.leaf(i, &l)) return 0;
        if (e.extends(l)) {
            ++e.count;
            put_u16(count_field, e.count);
            continue;
        }
        e.open = true;
        e.run = l.index != debug::RETAIN_NO_INDEX;
        e.id = l.id;
        e.tag = l.tag;
        e.cap = l.cap;
        e.first = l.index;
        e.count = 1;
        put_u32(out + at, l.id);
        out[at + 4] = static_cast<uint8_t>(l.tag | (e.run ? TRAILER_RUN_FLAG : 0));
        out[at + 5] = l.cap;
        if (e.run) {
            put_u32(out + at + 6, static_cast<uint32_t>(l.index));
            count_field = out + at + 10;
            put_u16(count_field, 1);
            at += ENTRY_RUN;
        } else {
            at += ENTRY_SINGLE;
        }
        ++entries;
    }
    put_u16(out + trailer_at, static_cast<uint16_t>(trailer));
    put_u16(out + trailer_at + 2, entries);

    put_u16(out + 0, MAGIC);
    out[2] = FORMAT_V2;
    out[3] = 0;
    put_u32(out + 4, debug::retain_layout_hash);
    put_u16(out + 8, static_cast<uint16_t>(payload));
    uint32_t crc = crc32(out, 10);
    crc = crc32(out + HEADER_SIZE, payload + trailer, crc);
    put_u32(out + 10, crc ^ 0xFFFFFFFFu);
    return total;
}

// -----------------------------------------------------------------------------
// Unpack
// -----------------------------------------------------------------------------

namespace detail {

/** A validated format-2 trailer, searched by identity. */
struct StoredTrailer {
    const uint8_t* entries;     // first entry
    uint16_t       count;       // entries
    const uint8_t* payload;     // first payload byte

    // Search cursor: the entry the last lookup matched (lookups mostly walk
    // forward, so starting there makes an unchanged or lightly edited layout
    // linear instead of quadratic).
    uint16_t cur_entry   = 0;
    uint16_t cur_pos     = 0;   // byte offset of that entry in `entries`
    uint32_t cur_offset  = 0;   // payload offset of its first element
    uint32_t cur_ordinal = 0;   // leaf ordinal of its first element

    struct Hit {
        uint8_t        tag;
        uint8_t        cap;
        const uint8_t* value;
        uint32_t       ordinal;
    };

    bool find(uint32_t id, int32_t index, Hit* hit) noexcept {
        uint16_t e = cur_entry, pos = cur_pos;
        uint32_t off = cur_offset, ord = cur_ordinal;
        for (uint16_t seen = 0; seen < count; ++seen) {
            const uint8_t* p = entries + pos;
            const uint8_t  tb = p[4];
            const uint8_t  tag = static_cast<uint8_t>(tb & ~TRAILER_RUN_FLAG);
            const uint8_t  cap = p[5];
            const uint32_t w = leaf_width(tag, cap);
            const bool     run = (tb & TRAILER_RUN_FLAG) != 0;
            const int32_t  first = run ? static_cast<int32_t>(get_u32(p + 6)) : 0;
            const uint16_t n = run ? get_u16(p + 10) : 1;
            if (get_u32(p) == id) {
                const bool match =
                    run ? (index != debug::RETAIN_NO_INDEX &&
                           static_cast<int64_t>(index) >= first &&
                           static_cast<int64_t>(index) < static_cast<int64_t>(first) + n)
                        : index == debug::RETAIN_NO_INDEX;
                if (match) {
                    const uint32_t k = run ? static_cast<uint32_t>(static_cast<int64_t>(index) - first) : 0;
                    hit->tag = tag;
                    hit->cap = cap;
                    hit->value = payload + off + k * w;
                    hit->ordinal = ord + k;
                    cur_entry = e;
                    cur_pos = pos;
                    cur_offset = off;
                    cur_ordinal = ord;
                    return true;
                }
            }
            // Next entry, wrapping to the first.
            ++e;
            pos = static_cast<uint16_t>(pos + (run ? ENTRY_RUN : ENTRY_SINGLE));
            off += w * n;
            ord += n;
            if (e == count) {
                e = 0;
                pos = 0;
                off = 0;
                ord = 0;
            }
        }
        return false;
    }
};

inline LoadResult finish(Report& r, LoadResult result, Report* out) noexcept {
    r.result = static_cast<uint8_t>(result);
    last_report() = r;
    if (out) *out = r;
    return result;
}

}  // namespace detail

/**
 * Restore the retained leaves from a stored blob of either format.
 *
 *   format 1  restored only into an identical layout (same retain_layout_hash),
 *             exactly as unpack() always did: it names no variables, so there
 *             is nothing to match by. A different layout is StaleLayout.
 *   format 2  validated as a whole first, then matched variable by variable
 *             (see the type rules above): Ok when the layout is identical,
 *             Migrated when it was not.
 *
 * Only Ok and Migrated write anything; every other result leaves every
 * variable at its declared initial value. A variable written nothing keeps its
 * initial value too — which is 6.5.6.2's initialization, not an omission.
 *
 * The outcome goes to `report` (if given) and to last_report().
 */
inline LoadResult unpack2(const uint8_t* blob, size_t len, const Host& host,
                          Report* report) noexcept {
    Report r = {};
    r.program_layout = debug::retain_layout_hash;
    if (debug::retain_var_count == 0) return detail::finish(r, LoadResult::Ok, report);
    if (blob == nullptr || len == 0) {
        r.added = debug::retain_var_count;
        return detail::finish(r, LoadResult::Empty, report);
    }
    if (len < HEADER_SIZE) return detail::finish(r, LoadResult::Truncated, report);
    if (get_u16(blob) != MAGIC) return detail::finish(r, LoadResult::BadMagic, report);
    r.format = blob[2];
    if (r.format != FORMAT_V1 && r.format != FORMAT_V2) {
        return detail::finish(r, LoadResult::BadFormat, report);
    }
    r.stored_layout = get_u32(blob + 4);
    const uint16_t payload = get_u16(blob + 8);
    // Subtractions, never `HEADER_SIZE + payload`: see unpack().
    if (len - HEADER_SIZE < payload) return detail::finish(r, LoadResult::Truncated, report);

    // ---- format 1 ----------------------------------------------------------
    if (r.format == FORMAT_V1) {
        uint32_t crc = crc32(blob, 10);
        crc = crc32(blob + HEADER_SIZE, payload, crc);
        if ((crc ^ 0xFFFFFFFFu) != get_u32(blob + 10)) {
            return detail::finish(r, LoadResult::BadCrc, report);
        }
        if (r.stored_layout != debug::retain_layout_hash) {
            return detail::finish(r, LoadResult::StaleLayout, report);
        }
        size_t need = 0;
        for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
            debug::RetainLeafInfo l;
            if (!host.leaf(i, &l)) return detail::finish(r, LoadResult::Truncated, report);
            need += host.wire_size(l.arr, l.elem);
        }
        if (payload != need) return detail::finish(r, LoadResult::Truncated, report);
        size_t at = HEADER_SIZE;
        for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
            debug::RetainLeafInfo l;
            host.leaf(i, &l);
            const uint16_t width = host.wire_size(l.arr, l.elem);
            if (width == 0) continue;
            if (host.write(l.arr, l.elem, blob + at, width) == WRITE_OK) {
                ++r.kept;
            } else {
                ++r.refused;
            }
            at += width;
        }
        return detail::finish(r, LoadResult::Ok, report);
    }

    // ---- format 2: validate everything before writing anything --------------
    if (len - HEADER_SIZE - payload < TRAILER_HEADER) {
        return detail::finish(r, LoadResult::Truncated, report);
    }
    const uint8_t* trailer = blob + HEADER_SIZE + payload;
    const uint16_t trailer_len = get_u16(trailer);
    if (trailer_len < TRAILER_HEADER) return detail::finish(r, LoadResult::BadTrailer, report);
    if (len - HEADER_SIZE - payload < trailer_len) {
        return detail::finish(r, LoadResult::Truncated, report);
    }
    {
        uint32_t crc = crc32(blob, 10);
        crc = crc32(blob + HEADER_SIZE, static_cast<size_t>(payload) + trailer_len, crc);
        if ((crc ^ 0xFFFFFFFFu) != get_u32(blob + 10)) {
            return detail::finish(r, LoadResult::BadCrc, report);
        }
    }
    const uint16_t entry_count = get_u16(trailer + 2);
    uint32_t stored_leaves = 0;
    {
        uint32_t pos = TRAILER_HEADER, widths = 0;
        for (uint16_t k = 0; k < entry_count; ++k) {
            if (pos + ENTRY_SINGLE > trailer_len) return detail::finish(r, LoadResult::BadTrailer, report);
            const uint8_t tb = trailer[pos + 4];
            const uint8_t tag = static_cast<uint8_t>(tb & ~TRAILER_RUN_FLAG);
            const uint32_t w = leaf_width(tag, trailer[pos + 5]);
            if (tag >= debug::TAG__COUNT || w == 0) {
                return detail::finish(r, LoadResult::BadTrailer, report);
            }
            uint32_t n = 1;
            if (tb & TRAILER_RUN_FLAG) {
                if (pos + ENTRY_RUN > trailer_len) return detail::finish(r, LoadResult::BadTrailer, report);
                n = get_u16(trailer + pos + 10);
                const int64_t last = static_cast<int64_t>(static_cast<int32_t>(get_u32(trailer + pos + 6))) + n - 1;
                if (n == 0 || last > INT32_MAX) return detail::finish(r, LoadResult::BadTrailer, report);
                pos += ENTRY_RUN;
            } else {
                pos += ENTRY_SINGLE;
            }
            widths += w * n;
            stored_leaves += n;
            if (widths > payload) return detail::finish(r, LoadResult::BadTrailer, report);
        }
        if (pos != trailer_len || widths != payload) {
            return detail::finish(r, LoadResult::BadTrailer, report);
        }
    }

    // ---- format 2: match by name and restore --------------------------------
    detail::StoredTrailer stored;
    stored.entries = trailer + TRAILER_HEADER;
    stored.count = entry_count;
    stored.payload = blob + HEADER_SIZE;
    bool identical = stored_leaves == debug::retain_var_count;
    uint32_t matched = 0;
    for (uint16_t i = 0; i < debug::retain_var_count; ++i) {
        debug::RetainLeafInfo l;
        if (!host.leaf(i, &l)) break;
        detail::StoredTrailer::Hit hit;
        if (!stored.find(l.id, l.index, &hit)) {
            ++r.added;  // a new variable: its initial value stands (6.5.6.2)
            identical = false;
            continue;
        }
        ++matched;
        if (hit.ordinal != i || hit.tag != l.tag || hit.cap != l.cap) identical = false;

        if (hit.tag == l.tag && is_text(l.tag)) {
            const uint16_t stored_cap = text_capacity(hit.cap);
            uint16_t units = hit.value[0];
            if (units > stored_cap) units = stored_cap;
            if (units > text_capacity(l.cap)) ++r.truncated;  // write_text keeps the first ones
            const uint16_t nbytes = static_cast<uint16_t>(l.tag == debug::TAG_WSTRING ? units * 2u : units);
            if (host.write_text(l.arr, l.elem, hit.value + 1, nbytes) == WRITE_OK) {
                ++r.kept;
            } else {
                ++r.refused;
            }
        } else if (hit.tag == l.tag) {
            if (host.write(l.arr, l.elem, hit.value, static_cast<uint16_t>(leaf_width(l.tag, l.cap))) == WRITE_OK) {
                ++r.kept;
            } else {
                ++r.refused;
            }
        } else if (implicitly_convertible(hit.tag, l.tag)) {
            uint8_t value[8] = {0};
            convert_value(hit.tag, hit.value, l.tag, value);
            if (host.write(l.arr, l.elem, value, static_cast<uint16_t>(leaf_width(l.tag, 0))) == WRITE_OK) {
                ++r.converted;
            } else {
                ++r.refused;
            }
        } else {
            ++r.refused;  // no implicit conversion in IEC Figure 12: initial value
        }
    }
    r.dropped = static_cast<uint16_t>(stored_leaves - matched);
    return detail::finish(r, identical && r.refused == 0 ? LoadResult::Ok : LoadResult::Migrated, report);
}

}  // namespace retain
}  // namespace strucpp
