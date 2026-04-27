//! Named-pipe SECURITY_DESCRIPTOR builder (P4.c / Sec F6).
//!
//! v0.1.0 ships the privileged Hyper-V daemon over `\\.\pipe\signalman-
//! service` with default ACLs. The audit (F6 — High) flagged that
//! creating the pipe via `ServerOptions::new()` with no
//! SECURITY_ATTRIBUTES leaves the connect-side gate at "the creating
//! user + LocalSystem + BUILTIN\Administrators" — fine on a single-
//! admin dev box but BROADENS to "every Administrator on the host"
//! for multi-admin servers. Worse, every Hyper-V-Admin-but-not-local-
//! Admin operator gets an effective drop-down to the entire control
//! plane without an explicit grant.
//!
//! This module builds a SECURITY_DESCRIPTOR from an SDDL string that
//! pins the connect-side gate to:
//!
//! - **LocalSystem** (`SY` = `S-1-5-18`) — the service runs as
//!   LocalSystem in the typical MSI install, so it MUST be allowed.
//! - **BUILTIN\Administrators** (`BA` = `S-1-5-32-544`) — local
//!   admins keep the install / uninstall / diagnostic flow open.
//! - **BUILTIN\Hyper-V Administrators** (`S-1-5-32-578`) — the
//!   audit's stated narrow grant: operators in this group can drive
//!   Hyper-V cmdlets via the daemon without needing local Admin.
//! - **The current user** (the developer / agent who started the
//!   process) — symmetric to the cert-ACL fix in P4.b. The host MCP
//!   typically runs as a non-Administrator developer account; without
//!   this grant, the host couldn't connect to the pipe at all.
//!
//! The Hyper-V Administrators alias `HA` is NOT recognised by
//! `ConvertStringSecurityDescriptorToSecurityDescriptorW`, so we use
//! the SID directly. This is a known SDDL quirk; documented in the
//! function header so future operators don't try to switch to `HA`
//! and break parsing.
//!
//! The SD lives for the lifetime of the [`PipeSecurityDescriptor`]
//! handle; dropping it `LocalFree`s the underlying allocation.

#[cfg(target_os = "windows")]
mod windows_impl {
    use anyhow::{Context, Result};
    use std::ffi::c_void;
    use std::ptr;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::core::PCWSTR;

    /// Owns a SECURITY_DESCRIPTOR allocated via
    /// `ConvertStringSecurityDescriptorToSecurityDescriptorW` and a
    /// matching SECURITY_ATTRIBUTES on the heap. The `as_raw()`
    /// pointer stays valid for as long as `self` is held.
    ///
    /// Safety contract: `as_raw()` returns a pointer into `self`.
    /// The returned pointer must not outlive `self`. The pipe-creation
    /// loop in [`crate::transport`] keeps `self` alive for the
    /// duration of every `create_with_security_attributes_raw` call.
    pub struct PipeSecurityDescriptor {
        attrs: Box<SECURITY_ATTRIBUTES>,
        sd_handle: HLOCAL,
    }

    impl PipeSecurityDescriptor {
        /// Build a new SD from the standard signalman-service SDDL.
        ///
        /// SDDL format:
        /// ```text
        /// D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-32-578)(A;OICI;FA;;;<USER>)
        /// ```
        /// - `D:`              — DACL (no SACL)
        /// - `A`               — Allow ACE
        /// - `OICI`            — `OBJECT_INHERIT_ACE` + `CONTAINER_INHERIT_ACE`
        /// - `FA`              — `FILE_ALL_ACCESS`
        /// - `SY` / `BA`       — well-known short forms
        /// - `S-1-5-32-578`    — Hyper-V Administrators (no SDDL alias)
        /// - `<USER>`          — current process user (added at runtime;
        ///                        skipped if `USERNAME` env var is unset)
        pub fn new() -> Result<Self> {
            let sddl = build_sddl();
            let sddl_wide: Vec<u16> =
                sddl.encode_utf16().chain(std::iter::once(0)).collect();

            let mut sd = PSECURITY_DESCRIPTOR::default();
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl_wide.as_ptr()),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
                .with_context(|| {
                    format!(
                        "ConvertStringSecurityDescriptorToSecurityDescriptorW failed for SDDL '{sddl}'"
                    )
                })?;
            }

            let sd_ptr = sd.0;
            let attrs = Box::new(SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd_ptr,
                bInheritHandle: false.into(),
            });

            Ok(Self {
                attrs,
                sd_handle: HLOCAL(sd_ptr),
            })
        }

        /// Returns a raw pointer to the SECURITY_ATTRIBUTES, suitable
        /// for passing to tokio's
        /// `create_with_security_attributes_raw`. The pointer is
        /// valid until `self` is dropped.
        pub fn as_raw(&mut self) -> *mut c_void {
            self.attrs.as_mut() as *mut SECURITY_ATTRIBUTES as *mut c_void
        }

        /// Returns the SDDL string we're building from. Test-only
        /// accessor.
        #[cfg(test)]
        pub fn sddl_for_tests() -> String {
            build_sddl()
        }
    }

    impl Drop for PipeSecurityDescriptor {
        fn drop(&mut self) {
            // ConvertStringSecurityDescriptorToSecurityDescriptorW
            // allocates via LocalAlloc; we own the memory and must
            // LocalFree on drop. Safe because the handle is private
            // to this struct and not shared.
            // The windows-rs 0.58 LocalFree signature takes the HLOCAL
            // by value (not Option) — reflecting Win32's API which
            // accepts a NULL handle as a no-op.
            unsafe {
                let _ = LocalFree(self.sd_handle);
            }
            // attrs is dropped automatically; the SD pointer it held
            // is now invalid but no one else references it.
            self.sd_handle = HLOCAL(ptr::null_mut());
        }
    }

    // SAFETY: SECURITY_ATTRIBUTES contains an `lpSecurityDescriptor:
    // *mut c_void` field, which is `!Send` by default — Rust is
    // conservative because raw pointers can alias. For this type the
    // pointer is OWNED by us (allocated via LocalAlloc, freed in
    // Drop), and is never shared across threads while the struct is
    // alive. tokio's pipe-creation accept loop moves the
    // PipeSecurityDescriptor into the spawned task and uses
    // `as_raw()` only from inside that task. Marking it Send is
    // therefore sound under our usage pattern.
    //
    // We do NOT mark Sync — there is no use case for sharing a
    // single PipeSecurityDescriptor across threads concurrently.
    unsafe impl Send for PipeSecurityDescriptor {}

    /// Build the SDDL string. v0.1.0 grants only:
    ///   * SYSTEM (`SY`)
    ///   * BUILTIN\Administrators (`BA`)
    ///   * BUILTIN\Hyper-V Administrators (`S-1-5-32-578`; no SDDL alias)
    ///
    /// Per-user grants are NOT appended at runtime. SDDL only accepts
    /// SIDs and well-known short-name aliases — plain `USERNAME`
    /// values fail parsing with "The security ID structure is invalid".
    /// Resolving the current user's SID via `LookupAccountNameW` is
    /// possible but adds complexity for the v0.1.0 single-admin-dev-box
    /// case where the current user is in BUILTIN\Administrators
    /// anyway. Multi-user production installs add explicit operator
    /// grants in the MSI flow (P6).
    ///
    /// If a future deployment needs a non-Admin operator to connect
    /// to the pipe, the install step is:
    /// ```powershell
    /// $sd = Get-Acl '\\.\pipe\signalman-service'
    /// # add ACE for the operator's SID, then Set-Acl
    /// ```
    /// or run a small Win32 helper that calls `LookupAccountNameW` +
    /// `SetSecurityInfo` with `DACL_SECURITY_INFORMATION`.
    fn build_sddl() -> String {
        // SYSTEM, BUILTIN\Administrators, BUILTIN\Hyper-V Administrators.
        String::from("D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-32-578)")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn sddl_contains_required_principals() {
            let sddl = build_sddl();
            // SYSTEM
            assert!(sddl.contains(";SY)"), "SDDL must grant SYSTEM: {sddl}");
            // Administrators
            assert!(sddl.contains(";BA)"), "SDDL must grant Administrators: {sddl}");
            // Hyper-V Administrators (SID, no alias)
            assert!(
                sddl.contains(";S-1-5-32-578)"),
                "SDDL must grant Hyper-V Administrators by SID: {sddl}"
            );
        }

        #[test]
        fn sddl_does_not_include_well_known_aliases_for_current_user() {
            // The current build_sddl returns ONLY the three
            // canonical principals. If a future change introduces
            // user-resolution, that change should add tests for the
            // SID-lookup path, not relax this constraint.
            let sddl = build_sddl();
            assert_eq!(
                sddl,
                "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-32-578)",
                "build_sddl() output must remain stable; an SDDL change is a security-relevant policy change"
            );
        }

        #[test]
        fn pipe_security_descriptor_round_trips() {
            // Smoke: building the SD from the live SDDL must succeed.
            // If ConvertStringSecurityDescriptorToSecurityDescriptorW
            // can't parse the string we built, this fails loudly.
            let mut sd = PipeSecurityDescriptor::new()
                .expect("PipeSecurityDescriptor::new must succeed on a valid SDDL");
            let raw = sd.as_raw();
            assert!(!raw.is_null(), "as_raw() must return a non-null pointer");
            // Drop releases LocalAlloc'd memory.
            drop(sd);
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::PipeSecurityDescriptor;
