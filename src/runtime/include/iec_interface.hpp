// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - interface variables (IEC 61131-3 Ed.3 6.6.6).
 *
 * An INTERFACE becomes two C++ types:
 *   - `NAME__IFACE`: an abstract class with the method prototypes. Function
 *     blocks that IMPLEMENT it derive from it (virtually, so an interface
 *     reached along several EXTENDS paths is one base, 6.6.6.6).
 *   - `NAME`: `IEC_IFACE_REF<NAME__IFACE>`, the type of a variable of the
 *     interface. Such a variable is a reference to an instance (6.6.6.2 b),
 *     NULL until assigned (6.6.6.5.1 item 4).
 *
 * Assignable to an interface variable (6.6.6.5.1): an instance of a block
 * implementing the interface or derived from one, another interface
 * variable of the same or a derived interface, and NULL. Two variables of
 * one interface compare equal when they reference the same instance or are
 * both NULL.
 *
 * Calling a method through a NULL interface variable is a runtime error
 * (6.6.6.5.2): it is reported the way a NULL REF_TO dereference is —
 * NullReferenceException on hosted builds, iec_runtime_fault(NullReference)
 * on builds without exceptions.
 *
 * Assignment attempt `?=` (6.6.6.7) needs the dynamic type of the referenced
 * instance. It does not use RTTI (boards build with -fno-rtti): every
 * interface derives from IEC_IFACE_ROOT, and each implementing block answers
 * __iec_query(id) with the matching base, or nullptr.
 */

#pragma once

#include <cstddef>
#include <type_traits>
#include "iec_pointer.hpp"

namespace strucpp {

/** Common virtual base of every interface: the assignment-attempt query. */
class IEC_IFACE_ROOT {
public:
    virtual ~IEC_IFACE_ROOT() = default;
    /** This instance as the type whose __iec_type_id() is `id`, else nullptr. */
    virtual void* __iec_query(const void* id) noexcept = 0;
};

/** A distinct address per type T: the id __iec_query answers to. */
template<typename T>
struct IEC_TYPE_ID {
    static const void* get() noexcept {
        static const char id = 0;
        return &id;
    }
};

/**
 * A variable of an interface type: a reference to an instance implementing
 * interface I, NULL by default.
 */
template<typename I>
class IEC_IFACE_REF {
public:
    using interface_type = I;

    IEC_IFACE_REF() noexcept : ptr_(nullptr) {}
    IEC_IFACE_REF(std::nullptr_t) noexcept : ptr_(nullptr) {}
    /** An instance of a block implementing I (or derived from one). */
    IEC_IFACE_REF(I& instance) noexcept : ptr_(&instance) {}
    /** A variable of an interface derived from I. */
    template<typename J,
             typename = typename std::enable_if<
                 !std::is_same<J, I>::value &&
                 std::is_convertible<J*, I*>::value>::type>
    IEC_IFACE_REF(const IEC_IFACE_REF<J>& other) noexcept
        : ptr_(other.get()) {}

    I* get() const noexcept { return ptr_; }
    bool is_null() const noexcept { return ptr_ == nullptr; }

    /** The referenced instance; a NULL reference is a runtime error (6.6.6.5.2). */
    I& deref() const {
        if (ptr_ == nullptr) {
#if STRUCPP_HAS_EXCEPTIONS
            throw NullReferenceException("interface method call");
#else
            iec_runtime_fault(IecFault::NullReference, "interface method call");
#endif
        }
        return *ptr_;
    }

    /** Method call through the interface: `ref->M(...)`. */
    I* operator->() const { return &deref(); }

    /** Assignment attempt (6.6.6.7) from an instance pointer: valid or NULL. */
    template<typename S>
    static IEC_IFACE_REF attempt(S* source) noexcept {
        IEC_IFACE_REF result;
        if (source != nullptr) {
            result.ptr_ = static_cast<I*>(
                source->__iec_query(IEC_TYPE_ID<I>::get()));
        }
        return result;
    }

    friend bool operator==(const IEC_IFACE_REF& a, const IEC_IFACE_REF& b) noexcept {
        return a.ptr_ == b.ptr_;
    }
    friend bool operator!=(const IEC_IFACE_REF& a, const IEC_IFACE_REF& b) noexcept {
        return a.ptr_ != b.ptr_;
    }
    friend bool operator==(const IEC_IFACE_REF& a, std::nullptr_t) noexcept {
        return a.ptr_ == nullptr;
    }
    friend bool operator==(std::nullptr_t, const IEC_IFACE_REF& a) noexcept {
        return a.ptr_ == nullptr;
    }
    friend bool operator!=(const IEC_IFACE_REF& a, std::nullptr_t) noexcept {
        return a.ptr_ != nullptr;
    }
    friend bool operator!=(std::nullptr_t, const IEC_IFACE_REF& a) noexcept {
        return a.ptr_ != nullptr;
    }

private:
    I* ptr_;
};

}  // namespace strucpp
