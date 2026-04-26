//! Subprocess invocation helper. Resolves the Signalman CLI from
//! `SIGNALMAN_CMD` (space-separated command line) or `signalman` on PATH,
//! validates the executable name against the [`crate::SUBPROCESS_ALLOWLIST`],
//! spawns it, and parses the JSON envelope on stdout.
//!
//! P5.1 invariants:
//!   * No shell expansion — args are passed as argv.
//!   * Allowlist enforcement is defense-in-depth; the canonical enforcement
//!     point is Loom's plugin host honoring
//!     [`loom_plugin_api::PluginCapability::RunSubprocess`].
//!   * Non-zero exit → [`LoomError::PluginRuntime`] containing the exit
//!     status and trimmed stderr. Signalman emits its envelope on stdout
//!     even on assertion failure (exit code 1), but propagates *spawn* and
//!     usage errors via stderr; we surface stderr only when exit != 0.
//!
//! Known gaps (deferred to P5.2):
//!   * **No subprocess timeout.** A hung `signalman run` blocks the plugin
//!     handler indefinitely. The fix arrives with run-handle persistence
//!     (P5.2): once Signalman runs return synchronously with a handle and
//!     events stream via Loom's [`EventBus`] (P5.3), the long-poll
//!     contract makes timeouts well-defined. Loom's plugin host is the
//!     outer guard until then.
//!   * **Env-var tests are not serialized.** The two `SIGNALMAN_CMD`
//!     manipulating tests below could race if cargo runs them in parallel.
//!     Acceptable for v0.1.0; the P7 test-pyramid work introduces
//!     `serial_test` (or equivalent) for env-touching tests.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

use loom_core::{LoomError, LoomResult};
use serde_json::Value;

use crate::SUBPROCESS_ALLOWLIST;

const ENV_CMD: &str = "SIGNALMAN_CMD";
const DEFAULT_CMD: &str = "signalman";

/// Resolves the Signalman command line from the environment.
///
/// Returns `(program, prefix_args)`. `prefix_args` is appended *before* the
/// caller's verb args so `SIGNALMAN_CMD="node host/dist/cli.js"` produces
/// `node host/dist/cli.js list --format json`.
pub fn resolve_command() -> (String, Vec<String>) {
    if let Ok(raw) = std::env::var(ENV_CMD) {
        let parts: Vec<&str> = raw.split_whitespace().collect();
        if let Some((first, rest)) = parts.split_first() {
            return (
                (*first).to_string(),
                rest.iter().map(|s| (*s).to_string()).collect(),
            );
        }
    }
    (DEFAULT_CMD.to_string(), Vec::new())
}

/// Returns the basename of `program` (without extension) for allowlist
/// comparison. `C:\Program Files\nodejs\node.exe` → `"node"`.
pub fn program_basename(program: &OsStr) -> String {
    let path = Path::new(program);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string_lossy().into_owned());
    stem.to_ascii_lowercase()
}

/// Validates `program` against [`SUBPROCESS_ALLOWLIST`].
pub fn check_allowlist(program: &OsStr) -> LoomResult<()> {
    let basename = program_basename(program);
    if SUBPROCESS_ALLOWLIST.iter().any(|allowed| basename == *allowed) {
        Ok(())
    } else {
        Err(LoomError::PluginRuntime(format!(
            "subprocess program '{}' is not in the Signalman plugin allowlist {:?}; \
             set SIGNALMAN_CMD to a path whose file name (without extension) is one of \
             these. The capability declaration is enforced by Loom's plugin host as well.",
            basename, SUBPROCESS_ALLOWLIST
        )))
    }
}

/// Invokes Signalman with the given verb args (e.g.
/// `["list", "--format", "json"]`) and returns the parsed JSON envelope.
pub fn run_signalman(verb_args: &[String]) -> LoomResult<Value> {
    let (program, prefix) = resolve_command();
    check_allowlist(OsStr::new(&program))?;

    let mut cmd = Command::new(&program);
    cmd.args(&prefix);
    cmd.args(verb_args);

    let output = cmd.output().map_err(|e| {
        LoomError::PluginRuntime(format!(
            "failed to spawn signalman ({} {}): {}",
            program,
            prefix.join(" "),
            e
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(LoomError::PluginRuntime(format!(
            "signalman exited with {}: {}",
            output.status,
            stderr.trim()
        )));
    }

    serde_json::from_slice(&output.stdout).map_err(LoomError::Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn resolve_command_defaults_to_signalman_when_env_unset() {
        // SAFETY: tests run on the same process; we save/restore.
        let saved = std::env::var(ENV_CMD).ok();
        unsafe {
            std::env::remove_var(ENV_CMD);
        }
        let (program, prefix) = resolve_command();
        assert_eq!(program, "signalman");
        assert!(prefix.is_empty());
        if let Some(s) = saved {
            unsafe {
                std::env::set_var(ENV_CMD, s);
            }
        }
    }

    #[test]
    fn resolve_command_splits_space_separated_env() {
        let saved = std::env::var(ENV_CMD).ok();
        unsafe {
            std::env::set_var(ENV_CMD, "node /opt/host/dist/cli.js");
        }
        let (program, prefix) = resolve_command();
        assert_eq!(program, "node");
        assert_eq!(prefix, vec!["/opt/host/dist/cli.js".to_string()]);
        match saved {
            Some(s) => unsafe { std::env::set_var(ENV_CMD, s) },
            None => unsafe { std::env::remove_var(ENV_CMD) },
        }
    }

    #[test]
    fn program_basename_strips_extension_and_path() {
        assert_eq!(program_basename(OsStr::new("signalman")), "signalman");
        assert_eq!(program_basename(OsStr::new("/usr/bin/signalman")), "signalman");
        assert_eq!(program_basename(&OsString::from("C:\\Program Files\\nodejs\\node.exe")), "node");
        assert_eq!(program_basename(OsStr::new("NODE.EXE")), "node");
    }

    #[test]
    fn allowlist_accepts_signalman_and_node() {
        check_allowlist(OsStr::new("signalman")).unwrap();
        check_allowlist(OsStr::new("/usr/local/bin/signalman")).unwrap();
        check_allowlist(OsStr::new("node")).unwrap();
        check_allowlist(OsStr::new("C:\\Program Files\\nodejs\\node.exe")).unwrap();
    }

    #[test]
    fn allowlist_rejects_arbitrary_programs() {
        assert!(check_allowlist(OsStr::new("rm")).is_err());
        assert!(check_allowlist(OsStr::new("powershell")).is_err());
        assert!(check_allowlist(OsStr::new("/bin/sh")).is_err());
        assert!(check_allowlist(OsStr::new("cmd.exe")).is_err());
    }
}
