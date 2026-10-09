// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
//
// ============================================================================
// WARNING: KEEP THIS HEADER C++14-CLEAN.
// ----------------------------------------------------------------------------
// strucpp targets C++17 and its EMITTED code is compiled as C++17 — but this
// header is part of the C/C++ Function Block include chain, which is NOT.
// OpenPLC Editor's Arduino flow emits `c_blocks_code.cpp`, including
// `iec_var.hpp` + `iec_string.hpp` (which transitively pull in `iec_traits.hpp`
// and `iec_types.hpp`). That translation unit is compiled under whatever
// `-std=` the Arduino core picks, and every mbed-based core — Nano RP2040
// Connect, Nano 33 BLE, Opta, GIGA, Portenta, Edge — hard-codes `-std=gnu++14`.
// So any C++17/20 construct reachable from here breaks the user's C/C++ POU
// build, even though the rest of strucpp is happily on C++17.
//
// In this header (and anything it includes) do NOT use C++17/20 features
// unguarded. In particular:
//   * `std::trait_v<T>`                -> `std::trait<T>::value`
//   * `if constexpr`                  -> SFINAE / tag dispatch
//   * inline variables / `inline constexpr`
//   * `auto` non-type template params -> typed NTTPs
//   * C++17/20 library headers (<optional>, <variant>, <string_view>,
//     <concepts>, ...) -> include ONLY behind `#if __cplusplus >= ...`
//     (see the guarded <concepts> block in iec_types.hpp for the pattern).
//
// Boundary introduced in commit be85d8a. If you change which headers
// `c_blocks_code.cpp` pulls in, update this set of warnings accordingly.
// ============================================================================
/**
 * STruC++ Runtime - IEC Variable Wrapper
 *
 * This header defines the IECVar template class that wraps IEC types
 * with support for variable forcing (a key OpenPLC feature).
 *
 * Located variables (AT %IX0.0, etc.) use this same wrapper, and the
 * raw_ptr() method provides access to the underlying storage for
 * runtime binding to I/O image tables.
 */

#pragma once

#include "iec_types.hpp"
#include "iec_fault.hpp"
#include <type_traits>
#include <utility>
#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#endif

/**
 * Calling form of the variable accessors (IECVar / IEC_ENUM_Var get and set)
 * in a size-optimised build.
 *
 * At -Os GCC keeps get() and set() out of line, then specialises each one with
 * IPA-SRA so every call site passes the object's fields (value, force flag,
 * forced value) instead of the object's address — several extra instructions
 * per read and per write of a variable, in every POU. `noipa` keeps the one
 * plain out-of-line accessor called with `this`. It changes how the accessor is
 * called, never what it does: the forcing semantics above are untouched.
 *
 * Only where it is known to shrink code: GCC 8+ (`noipa` is unknown before)
 * optimising for size (`__OPTIMIZE_SIZE__`, i.e. -Os, the board builds). A
 * host build at -O1/-O2 keeps inlining the accessors, so the runtime's speed
 * is unchanged; Clang and MSVC see nothing.
 */
#if defined(__GNUC__) && !defined(__clang__) && (__GNUC__ >= 8) && defined(__OPTIMIZE_SIZE__)
#  define STRUCPP_ACCESSOR __attribute__((noinline, noipa))
#else
#  define STRUCPP_ACCESSOR
#endif

namespace strucpp {

// Forward declaration for pointer-to-integer assignment
template<typename T> class IEC_Ptr;

// =============================================================================
// IEC Variable Wrapper
// =============================================================================

/**
 * Template wrapper for IEC variables with forcing support.
 *
 * This class wraps any IEC type and provides:
 * - Normal get/set operations
 * - Variable forcing (override value for debugging/testing)
 * - Implicit conversion for natural syntax
 * - Arithmetic operators for numeric types
 *
 * @tparam T The underlying C++ type (e.g., int16_t for INT)
 */
template<typename T>
class IECVar {
public:
    using value_type = T;

    // =========================================================================
    // Constructors
    // =========================================================================

    /** Default constructor - initializes to zero/false */
    constexpr IECVar() noexcept : value_{}, forced_{false}, forced_value_{} {}

    /** Construct with initial value (non-explicit to allow IEC_INT val = 10 syntax) */
    constexpr IECVar(T v) noexcept : value_{v}, forced_{false}, forced_value_{} {}

    /** Cross-type converting constructor: IECVar<SINT_t> → IECVar<INT_t> etc.
     *  Enables implicit widening when struct fields (now IECVar-wrapped) are passed
     *  to functions expecting a wider IECVar type. Without this, C++ would need
     *  two user-defined conversions (IECVar<U>→U→T→IECVar<T>) which is disallowed. */
    template<typename U, std::enable_if_t<
        std::is_convertible<U, T>::value && !std::is_same<U, T>::value, int> = 0>
    constexpr IECVar(const IECVar<U>& other) noexcept
        : value_{static_cast<T>(other.get())}, forced_{false}, forced_value_{} {}

    /** Copy constructor — fresh IECVar starts unforced regardless of source. */
    constexpr IECVar(const IECVar& other) noexcept
        : value_{other.get()}, forced_{false}, forced_value_{} {}

    /** Move constructor — same semantics as copy. */
    constexpr IECVar(IECVar&& other) noexcept
        : value_{other.get()}, forced_{false}, forced_value_{} {}

    /**
     * Copy assignment.
     *
     * Assigning FROM another IECVar must go through `set()` so forcing
     * state is preserved on the destination. A memberwise copy would
     * clobber `forced_` / `forced_value_`, silently unforcing variables
     * that the debugger is holding — precisely what generated PLC code
     * does every scan cycle with `BLINK := TOF0.Q`.
     */
    constexpr IECVar& operator=(const IECVar& other) noexcept {
        set(other.get());
        return *this;
    }

    /** Move assignment — same semantics as copy. */
    constexpr IECVar& operator=(IECVar&& other) noexcept {
        set(other.get());
        return *this;
    }

    // =========================================================================
    // Value Access
    // =========================================================================

    /**
     * Get the current value.
     * Returns the forced value if forcing is active, otherwise the normal value.
     */
    STRUCPP_ACCESSOR constexpr T get() const noexcept {
        return forced_ ? forced_value_ : value_;
    }

    /**
     * Set the value.
     * If forcing is active, the set is ignored to ensure drivers reading
     * the raw storage always see the forced value for output variables.
     */
    STRUCPP_ACCESSOR constexpr void set(T v) noexcept {
        if (!forced_) {
            value_ = v;
        }
    }

    /**
     * Get the underlying value (ignoring forcing).
     * Useful for debugging to see what the program would have set.
     */
    T get_underlying() const noexcept {
        return value_;
    }

    // =========================================================================
    // Forcing Support
    // =========================================================================

    /**
     * Force the variable to a specific value.
     * While forced, get() will return the forced value regardless of set() calls.
     * Also updates the raw storage so drivers reading via raw_ptr() see the forced value.
     */
    void force(T v) noexcept {
        forced_ = true;
        forced_value_ = v;
        value_ = v;  // Update raw value so external readers (plugins) see forced value
    }

    /**
     * Remove forcing and return to normal operation.
     */
    void unforce() noexcept {
        forced_ = false;
    }

    /**
     * Check if the variable is currently forced.
     */
    bool is_forced() const noexcept {
        return forced_;
    }

    /**
     * Get the forced value (only valid if is_forced() is true).
     */
    T get_forced_value() const noexcept {
        return forced_value_;
    }

    // =========================================================================
    // Raw Pointer Access (for Located Variables)
    // =========================================================================

    /**
     * Get a pointer to the underlying raw storage.
     * Used by the runtime to bind located variables to I/O image tables.
     * Plugins and drivers read/write through this pointer.
     *
     * For inputs: drivers write to this pointer, get() returns forced value when forced
     * For outputs: force() updates this storage, so drivers always read the forced value
     */
    T* raw_ptr() noexcept { return &value_; }

    /**
     * Get a const pointer to the underlying raw storage.
     */
    const T* raw_ptr() const noexcept { return &value_; }

    /**
     * Get a const pointer to the value a READER should see, honouring force.
     *
     * Not the same as raw_ptr(). force() writes through to value_, so the two
     * agree the moment a force is applied — but a located variable is driven by
     * the PLC program every scan, and the program writes value_ directly through
     * the image binding, not through set(). raw_ptr() would then show the
     * program's value while get() still reports the forced one.
     *
     * So this is get()'s semantics with get()'s copy removed, which is what an
     * external reader (the debug dispatch's pointer op, and through it OPC-UA)
     * needs to serve a value without copying it. Mirrors IECStringVar::c_str(),
     * which resolves the force the same way.
     */
    const T* read_ptr() const noexcept { return forced_ ? &forced_value_ : &value_; }

    // =========================================================================
    // Implicit Conversions
    // =========================================================================

    /** Implicit conversion to underlying type for natural syntax */
    constexpr operator T() const noexcept {
        return get();
    }

    /** Assignment from raw value */
    constexpr IECVar& operator=(T v) noexcept {
        set(v);
        return *this;
    }

    /** Cross-type assignment: IECVar<SINT_t> → IECVar<INT_t> etc.
     *  Resolves ambiguity when assigning between different IECVar specializations
     *  by providing a direct match (template is preferred over two indirect paths
     *  that each require one user-defined conversion). */
    template<typename U, std::enable_if_t<
        std::is_convertible<U, T>::value && !std::is_same<U, T>::value, int> = 0>
    constexpr IECVar& operator=(const IECVar<U>& other) noexcept {
        set(static_cast<T>(other.get()));
        return *this;
    }

    /** Assignment from IEC_Ptr (CODESYS: DWORD_VAR := PT stores address as integer).
     *  WARNING: On 64-bit platforms, assigning to types narrower than pointer width
     *  (e.g., DWORD) truncates the address. Use ULINT, LWORD, or PTR_INT_t for
     *  portable pointer-to-integer storage. */
    template<typename U, typename V = T, std::enable_if_t<std::is_integral<V>::value, int> = 0>
    IECVar& operator=(const IEC_Ptr<U>& ptr) noexcept {
        set(static_cast<T>(ptr.to_addr()));
        return *this;
    }

    /** Assignment from a raw pointer — stores the address as an integer.
     *  Used by the ADR(x) lowering `_TMP : __XWORD := &(x)`. Integral targets
     *  only; routed through uintptr_t so it is pointer-width-correct per
     *  target (no truncation when T is __XWORD/XWORD_t). */
    template<typename U, typename V = T, std::enable_if_t<std::is_integral<V>::value, int> = 0>
    IECVar& operator=(U* p) noexcept {
        set(static_cast<T>(reinterpret_cast<std::uintptr_t>(p)));
        return *this;
    }

    // =========================================================================
    // Container Access Forwarding (for array/struct types)
    // =========================================================================

    /** Forward operator-> to underlying type (struct/FB member access) */
    template<typename U = T, std::enable_if_t<std::is_class<U>::value, int> = 0>
    T* operator->() noexcept { return &value_; }

    template<typename U = T, std::enable_if_t<std::is_class<U>::value, int> = 0>
    const T* operator->() const noexcept { return &value_; }

    /** Forward operator[] to underlying type (1D array access) */
    template<typename Index>
    auto operator[](Index i) noexcept -> decltype(std::declval<T&>()[i]) {
        return value_[i];
    }

    template<typename Index>
    auto operator[](Index i) const noexcept -> decltype(std::declval<const T&>()[i]) {
        return value_[i];
    }

    /** Forward operator() to underlying type (2D+ array access) */
    template<typename... Args>
    auto operator()(Args... args) noexcept -> decltype(std::declval<T&>()(args...)) {
        return value_(args...);
    }

    template<typename... Args>
    auto operator()(Args... args) const noexcept -> decltype(std::declval<const T&>()(args...)) {
        return value_(args...);
    }

    // =========================================================================
    // Arithmetic Operators
    // =========================================================================

    IECVar& operator+=(T v) noexcept {
        set(get() + v);
        return *this;
    }

    IECVar& operator-=(T v) noexcept {
        set(get() - v);
        return *this;
    }

    IECVar& operator*=(T v) noexcept {
        set(get() * v);
        return *this;
    }

    IECVar& operator/=(T v) noexcept {
        set(get() / v);
        return *this;
    }

    IECVar& operator%=(T v) noexcept {
        set(get() % v);
        return *this;
    }

    // Prefix increment
    IECVar& operator++() noexcept {
        set(get() + 1);
        return *this;
    }

    // Postfix increment
    IECVar operator++(int) noexcept {
        IECVar tmp = *this;
        ++(*this);
        return tmp;
    }

    // Prefix decrement
    IECVar& operator--() noexcept {
        set(get() - 1);
        return *this;
    }

    // Postfix decrement
    IECVar operator--(int) noexcept {
        IECVar tmp = *this;
        --(*this);
        return tmp;
    }

    // =========================================================================
    // Bitwise Operators (for bit string types)
    // =========================================================================

    IECVar& operator&=(T v) noexcept {
        set(get() & v);
        return *this;
    }

    IECVar& operator|=(T v) noexcept {
        set(get() | v);
        return *this;
    }

    IECVar& operator^=(T v) noexcept {
        set(get() ^ v);
        return *this;
    }

    /**
     * Byte offset of the payload, which must stay 0.
     *
     * `ADR(x)` lowers to `&(x)`, the wrapper's address, and every consumer
     * reads it as a `T*`. Correct only while `value_` is the first member,
     * which the static_asserts below pin.
     */
    static constexpr std::size_t value_field_offset() noexcept { return offsetof(IECVar, value_); }

private:
    T value_;           ///< The actual value
    bool forced_;       ///< Whether forcing is active
    T forced_value_;    ///< The forced value (when forced_ is true)
};

// `&(x)` and `x.raw_ptr()` must name the same address — see
// `value_field_offset()`. Checked for a representative spread of payload types,
// since alignment differs across them.
static_assert(IECVar<bool>::value_field_offset() == 0, "IECVar<bool> payload must be first");
static_assert(IECVar<int16_t>::value_field_offset() == 0, "IECVar<INT> payload must be first");
static_assert(IECVar<int32_t>::value_field_offset() == 0, "IECVar<DINT> payload must be first");
static_assert(IECVar<float>::value_field_offset() == 0, "IECVar<REAL> payload must be first");
static_assert(IECVar<double>::value_field_offset() == 0, "IECVar<LREAL> payload must be first");
static_assert(IECVar<int64_t>::value_field_offset() == 0, "IECVar<LINT> payload must be first");

// =============================================================================
// Binary Operators
//
// The result of an arithmetic or bitwise operation is the OPERANDS' type
// (IEC 61131-3 §6.6.1.7.2: "The data types of inputs and the outputs/result
// shall be of the same type"; "dint1:= int1 + int2; (* Addition is performed
// as an integer operation, then the result is converted to a DINT *)"), so
// each operator converts C++'s promoted result back to T — exactly what the
// IECVar<T> it used to return did on construction. It returns that T itself:
// a temporary is never forced, so wrapping it in an IECVar (value + force flag
// + forced copy, copied out again by the caller) only cost code. Where a
// result feeds another operator or a call, T and IECVar<T> select the same
// arithmetic; none of the value semantics change.
// =============================================================================

template<typename T>
inline T operator+(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() + b.get());
}

template<typename T>
inline T operator-(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() - b.get());
}

template<typename T>
inline T operator*(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() * b.get());
}

template<typename T>
inline T operator/(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() / b.get());
}

template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>>
inline T operator%(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() % b.get());
}

// Mixed-type arithmetic operators (IECVar<T> op T) and (T op IECVar<T>)
template<typename T> inline T operator+(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() + b); }
template<typename T> inline T operator+(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a + b.get()); }
template<typename T> inline T operator-(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() - b); }
template<typename T> inline T operator-(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a - b.get()); }
template<typename T> inline T operator*(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() * b); }
template<typename T> inline T operator*(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a * b.get()); }
template<typename T> inline T operator/(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() / b); }
template<typename T> inline T operator/(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a / b.get()); }
template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>> inline T operator%(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() % b); }
template<typename T, typename = std::enable_if_t<std::is_integral<T>::value>> inline T operator%(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a % b.get()); }

// =============================================================================
// Comparison Operators
// =============================================================================

template<typename T>
inline bool operator==(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() == b.get();
}

template<typename T>
inline bool operator!=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() != b.get();
}

template<typename T>
inline bool operator<(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() < b.get();
}

template<typename T>
inline bool operator>(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() > b.get();
}

template<typename T>
inline bool operator<=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() <= b.get();
}

template<typename T>
inline bool operator>=(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return a.get() >= b.get();
}

// Mixed-type comparison operators
template<typename T> inline bool operator==(const IECVar<T>& a, T b) noexcept { return a.get() == b; }
template<typename T> inline bool operator==(T a, const IECVar<T>& b) noexcept { return a == b.get(); }
template<typename T> inline bool operator!=(const IECVar<T>& a, T b) noexcept { return a.get() != b; }
template<typename T> inline bool operator!=(T a, const IECVar<T>& b) noexcept { return a != b.get(); }
template<typename T> inline bool operator<(const IECVar<T>& a, T b) noexcept { return a.get() < b; }
template<typename T> inline bool operator<(T a, const IECVar<T>& b) noexcept { return a < b.get(); }
template<typename T> inline bool operator>(const IECVar<T>& a, T b) noexcept { return a.get() > b; }
template<typename T> inline bool operator>(T a, const IECVar<T>& b) noexcept { return a > b.get(); }
template<typename T> inline bool operator<=(const IECVar<T>& a, T b) noexcept { return a.get() <= b; }
template<typename T> inline bool operator<=(T a, const IECVar<T>& b) noexcept { return a <= b.get(); }
template<typename T> inline bool operator>=(const IECVar<T>& a, T b) noexcept { return a.get() >= b; }
template<typename T> inline bool operator>=(T a, const IECVar<T>& b) noexcept { return a >= b.get(); }

// =============================================================================
// Bitwise Operators
// =============================================================================

template<typename T>
inline T operator&(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() & b.get());
}

template<typename T>
inline T operator|(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() | b.get());
}

template<typename T>
inline T operator^(const IECVar<T>& a, const IECVar<T>& b) noexcept {
    return static_cast<T>(a.get() ^ b.get());
}

// Mixed-type bitwise operators
template<typename T> inline T operator&(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() & b); }
template<typename T> inline T operator&(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a & b.get()); }
template<typename T> inline T operator|(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() | b); }
template<typename T> inline T operator|(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a | b.get()); }
template<typename T> inline T operator^(const IECVar<T>& a, T b) noexcept { return static_cast<T>(a.get() ^ b); }
template<typename T> inline T operator^(T a, const IECVar<T>& b) noexcept { return static_cast<T>(a ^ b.get()); }

template<typename T>
inline T operator~(const IECVar<T>& a) noexcept {
    return static_cast<T>(~a.get());
}

// =============================================================================
// IEC Type Aliases with Forcing Support
// =============================================================================

// Boolean
using IEC_BOOL = IECVar<BOOL_t>;

// Bit strings
using IEC_BYTE = IECVar<BYTE_t>;
using IEC_WORD = IECVar<WORD_t>;
using IEC_DWORD = IECVar<DWORD_t>;
using IEC_LWORD = IECVar<LWORD_t>;
// CODESYS __XWORD — pointer-width unsigned (see XWORD_t in iec_types.hpp).
using IEC_XWORD = IECVar<XWORD_t>;

// Signed integers
using IEC_SINT = IECVar<SINT_t>;
using IEC_INT = IECVar<INT_t>;
using IEC_DINT = IECVar<DINT_t>;
using IEC_LINT = IECVar<LINT_t>;

// Unsigned integers
using IEC_USINT = IECVar<USINT_t>;
using IEC_UINT = IECVar<UINT_t>;
using IEC_UDINT = IECVar<UDINT_t>;
using IEC_ULINT = IECVar<ULINT_t>;

// Real numbers
using IEC_REAL = IECVar<REAL_t>;
using IEC_LREAL = IECVar<LREAL_t>;

// Time types
using IEC_TIME = IECVar<TIME_t>;
using IEC_DATE = IECVar<DATE_t>;
using IEC_TOD = IECVar<TOD_t>;
using IEC_DT = IECVar<DT_t>;

// IEC v3 Long time types
using IEC_LTIME = IECVar<LTIME_t>;
using IEC_LDATE = IECVar<LDATE_t>;
using IEC_LTOD = IECVar<LTOD_t>;
using IEC_LDT = IECVar<LDT_t>;

// Character types
using IEC_CHAR = IECVar<CHAR_t>;
using IEC_WCHAR = IECVar<WCHAR_t>;

// Aliases for compatibility
using IEC_TIME_OF_DAY = IEC_TOD;
using IEC_DATE_AND_TIME = IEC_DT;
using IEC_LONG_TIME_OF_DAY = IEC_LTOD;
using IEC_LONG_DATE_AND_TIME = IEC_LDT;

// =============================================================================
// VAR_IN_OUT of a function block
// =============================================================================

/**
 * A function block's VAR_IN_OUT parameter: the caller's variable, reached
 * through a reference the call binds.
 *
 * IEC 61131-3 §3.48: an in-out variable "is used to supply a value to a
 * program organization unit and which is additionally used to return a value
 * from the program organization unit"; the block reads and writes the caller's
 * variable itself (§6.6.2.2 rule 6, Figure 13 NOTE 3), and the binding is
 * stored in the instance between calls (§6.6.3.4.1: "the instance shall be
 * provided with a valid value which is stored, e.g. via initialization or
 * former call, before used in the function block (body) ... otherwise it
 * causes a runtime error").
 *
 * The member is the binding alone, one pointer: `ref` points at the caller's
 * own wrapper (IECVar, struct, string, array), so reads go through get() and
 * writes through set() and a forced variable keeps its forced value. Where a
 * reference cannot be made — a bit of a word, an actual of another type
 * (STRING(10) on a STRING(20) in-out), a shared global the call cannot hold
 * the lock of — the CALL provides the copy (`InOutSlot` or a temporary beside
 * the call), binds it, copies it back and unbinds. Unbound, `ref` is null: the
 * debugger shows no value, and a call that leaves the in-out out raises the
 * runtime error (`require()`).
 */
template<typename V>
class InOut {
public:
    using value_type = V;

    InOut() noexcept : ref(nullptr) {}
    /** A copy of an instance keeps its binding (§6.6.3.4.1). */
    InOut(const InOut& other) noexcept = default;
    InOut& operator=(const InOut& other) noexcept = default;

    /**
     * Copying a value INTO the member was the copy-in form of a STruC++ whose
     * in-outs held their own copy. Only code generated by that STruC++ (a
     * library built with it) still does it.
     */
    template<typename A>
    InOut& operator=(const A&) noexcept {
        static_assert(sizeof(A) == 0,
            "VAR_IN_OUT copy-in from code generated by an older STruC++ "
            "(in-outs held their own copy): rebuild the library with this STruC++");
        return *this;
    }

    /** Bind the caller's variable itself. */
    void bind(V& actual) noexcept { ref = &actual; }
    /** Drop a binding whose target does not outlive the call (a call's copy). */
    void unbind() noexcept { ref = nullptr; }

    /**
     * A call that leaves the in-out out works on the stored binding; with none,
     * that is the runtime error §6.6.3.4.1 names (a null reference fault).
     */
    void require() const {
        if (ref == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw std::runtime_error("VAR_IN_OUT used before it was bound");
#else
            iec_runtime_fault(IecFault::NullReference, "VAR_IN_OUT not bound");
#endif
        }
    }

    V& var() noexcept { return *ref; }
    const V& var() const noexcept { return *ref; }
    operator V&() noexcept { return *ref; }
    operator const V&() const noexcept { return *ref; }

    /**
     * C++ written against the member directly (a C/C++ block's `{external}`
     * glue: `vars.IO = &IO;`, `&IO[lower] - lower`) reaches the bound variable.
     */
    V* operator&() noexcept { return ref; }
    const V* operator&() const noexcept { return ref; }
    template<typename I>
    auto operator[](I i) noexcept -> decltype((*std::declval<V*>())[i]) { return (*ref)[i]; }

    V* ref;   ///< The variable the block works on; null while unbound
};

/** The declared type of an in-out member (`decltype(fb.IO)`). */
template<typename IO>
using inout_value_t = typename std::remove_reference<IO>::type::value_type;

/**
 * The call's own copy of an in-out's actual, where the actual is of another
 * type than the in-out and cannot be bound: empty when it is the same type.
 * Declared beside the call, so it lives exactly as long as the call needs it.
 */
template<typename V, typename A>
struct InOutSlot { V copy; };
template<typename V>
struct InOutSlot<V, V> {};

/** `InOutSlot` for the member `IO` and the actual `A` (as `decltype` names them). */
template<typename IO, typename A>
using inout_slot_t = InOutSlot<inout_value_t<IO>,
    typename std::remove_cv<typename std::remove_reference<A>::type>::type>;

/**
 * Bind an in-out to the caller's variable before the call: by reference when
 * it is of the in-out's own type, else to the call's copy of it.
 */
template<typename V>
inline void iec_inout_bind(InOut<V>& io, V& actual, InOutSlot<V, V>&) noexcept {
    io.bind(actual);
}
template<typename V, typename A>
inline void iec_inout_bind(InOut<V>& io, A& actual, InOutSlot<V, A>& slot) noexcept {
    slot.copy = actual;
    io.bind(slot.copy);
}

/** After the call: copy the call's copy back, and drop the binding to it. */
template<typename V>
inline void iec_inout_back(InOut<V>&, V&, InOutSlot<V, V>&) noexcept {}
template<typename V, typename A>
inline void iec_inout_back(InOut<V>& io, A& actual, InOutSlot<V, A>& slot) noexcept {
    actual = slot.copy;
    io.unbind();
}

/**
 * The two-argument forms are what a library built by an older STruC++ calls.
 * A same-type actual binds as before; one that needs a copy has nowhere to
 * keep it, so it is refused when the library's code is compiled.
 */
template<typename V>
inline bool iec_inout_bind(InOut<V>& io, V& actual) noexcept {
    io.bind(actual);
    return false;
}
template<typename V, typename A>
inline bool iec_inout_bind(InOut<V>&, A&) noexcept {
    static_assert(sizeof(A) == 0,
        "VAR_IN_OUT copy-in from code generated by an older STruC++ "
        "(in-outs held their own copy): rebuild the library with this STruC++");
    return true;
}
template<typename V, typename A>
inline void iec_inout_back(InOut<V>&, A&) noexcept {}

} // namespace strucpp
