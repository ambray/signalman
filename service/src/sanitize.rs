//! Defense-in-depth sanitizers, ported from `host/src/sanitize.ts`.
//!
//! Every user-supplied value that ends up interpolated into a PowerShell
//! script must pass through these validators at the service boundary,
//! BEFORE any cmdlet is invoked. The host-side TS sanitizers stay in
//! place; this is a second wall.
//!
//! Parity goal: each rejection exercised by `sanitize.test.ts` must
//! also be exercised by an equivalent test in `mod tests` below.

use thiserror::Error;

/// Sanitizer rejection. Mirrors the `Error` thrown by the TS validators.
///
/// We expose specific variants so the gRPC layer can map them to
/// `Code::InvalidArgument` with descriptive messages.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SanitizeError {
    /// Generic invalid-input error with a descriptive message.
    #[error("invalid input: {0}")]
    Invalid(String),
}

/// Helper: build an error matching the TS message format.
fn invalid<S: Into<String>>(msg: S) -> SanitizeError {
    SanitizeError::Invalid(msg.into())
}

/// VM name: alphanumeric, hyphens, underscores; 1-100 chars; first char
/// must NOT be a hyphen.
///
/// Mirrors the TS regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$`.
pub fn sanitize_vm_name(name: &str) -> Result<&str, SanitizeError> {
    if name.is_empty() || name.len() > 100 {
        return Err(invalid(format!(
            "Invalid VM name: \"{name}\". Must be 1-100 chars, alphanumeric/hyphens/underscores."
        )));
    }
    let mut chars = name.chars();
    let first = chars.next().expect("non-empty checked above");
    if !first.is_ascii_alphanumeric() {
        return Err(invalid(format!(
            "Invalid VM name: \"{name}\". Must be 1-100 chars, alphanumeric/hyphens/underscores."
        )));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(invalid(format!(
                "Invalid VM name: \"{name}\". Must be 1-100 chars, alphanumeric/hyphens/underscores."
            )));
        }
    }
    Ok(name)
}

/// Checkpoint label: alphanumeric, spaces, hyphens, underscores;
/// 1-200 chars; first char must NOT be a space.
///
/// Mirrors the TS regex `^[a-zA-Z0-9][a-zA-Z0-9_ -]{0,199}$`.
pub fn sanitize_label(label: &str) -> Result<&str, SanitizeError> {
    if label.is_empty() || label.len() > 200 {
        return Err(invalid(format!(
            "Invalid label: \"{label}\". Must be 1-200 chars, alphanumeric/spaces/hyphens/underscores."
        )));
    }
    let mut chars = label.chars();
    let first = chars.next().expect("non-empty checked above");
    if !first.is_ascii_alphanumeric() {
        return Err(invalid(format!(
            "Invalid label: \"{label}\". Must be 1-200 chars, alphanumeric/spaces/hyphens/underscores."
        )));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ') {
            return Err(invalid(format!(
                "Invalid label: \"{label}\". Must be 1-200 chars, alphanumeric/spaces/hyphens/underscores."
            )));
        }
    }
    Ok(label)
}

/// File path validator. Rejects null bytes, PowerShell metacharacters,
/// and single quotes (which would break our PowerShell single-quoted
/// string escaping).
///
/// Mirrors the TS regex `[;`$@{}|"]` plus null-byte and single-quote
/// checks.
pub fn sanitize_path(path: &str) -> Result<&str, SanitizeError> {
    if path.contains('\0') {
        return Err(invalid("Path contains null byte"));
    }
    for c in path.chars() {
        if matches!(c, ';' | '`' | '$' | '@' | '{' | '}' | '|' | '"') {
            return Err(invalid(format!(
                "Path contains dangerous characters: \"{path}\""
            )));
        }
    }
    if path.contains('\'') {
        return Err(invalid(format!("Path contains single quote: \"{path}\"")));
    }
    Ok(path)
}

/// Command-name validator. Rejects null bytes and shell metacharacters.
///
/// Mirrors the TS regex `[;`$@{}|&]` plus null-byte check.
pub fn sanitize_command(command: &str) -> Result<&str, SanitizeError> {
    if command.contains('\0') {
        return Err(invalid("Command contains null byte"));
    }
    for c in command.chars() {
        if matches!(c, ';' | '`' | '$' | '@' | '{' | '}' | '|' | '&') {
            return Err(invalid(format!(
                "Command contains shell metacharacters: \"{command}\""
            )));
        }
    }
    Ok(command)
}

/// Escape a single argument for embedding in a PowerShell single-quoted
/// string. The only escape is `''` for a literal `'`.
///
/// Mirrors `escapePowerShellArg` in the TS sanitizer.
pub fn escape_powershell_arg(arg: &str) -> String {
    arg.replace('\'', "''")
}

/// Validate a URL: must parse and use http/https scheme. Mirrors the
/// TS `sanitizeUrl` validator.
///
/// We avoid pulling in a full URL crate for one validator. Hand-rolled
/// scheme + authority check is sufficient for v0.1.0.
pub fn sanitize_url(url: &str) -> Result<&str, SanitizeError> {
    let lower_idx = url
        .find(':')
        .ok_or_else(|| invalid(format!("Invalid URL: \"{url}\" — missing scheme delimiter")))?;
    let scheme = &url[..lower_idx];
    let scheme_lower = scheme.to_ascii_lowercase();
    if scheme_lower != "http" && scheme_lower != "https" {
        return Err(invalid(format!("Invalid URL protocol: {scheme_lower}:")));
    }
    // Require `://authority`.
    let rest = &url[lower_idx + 1..];
    if !rest.starts_with("//") || rest.len() < 3 {
        return Err(invalid(format!(
            "Invalid URL: \"{url}\" — missing authority"
        )));
    }
    let authority = &rest[2..];
    let host_end = authority.find('/').unwrap_or(authority.len());
    if host_end == 0 {
        return Err(invalid(format!("Invalid URL: \"{url}\" — empty host")));
    }
    let host = &authority[..host_end];
    if host.contains(' ') {
        return Err(invalid(format!(
            "Invalid URL: \"{url}\" — whitespace in host"
        )));
    }
    Ok(url)
}

/// Clamp a timeout (ms) into `[1_000, max]`. None / NaN-equivalents get
/// the default of `30_000`.
///
/// Mirrors `sanitizeTimeout`. We accept `Option<u64>` since the proto
/// uses `uint32` and "missing" is naturally `None`.
pub fn sanitize_timeout(timeout: Option<u64>, max: u64) -> u64 {
    let t = timeout.unwrap_or(30_000);
    t.clamp(1_000, max)
}

/// Convenience wrapper using the canonical 600_000ms default cap.
pub fn sanitize_timeout_default(timeout: Option<u64>) -> u64 {
    sanitize_timeout(timeout, 600_000)
}

#[cfg(test)]
mod tests {
    //! Each `describe` block in `host/src/__tests__/sanitize.test.ts`
    //! has a corresponding `mod` here. Test names mirror the TS `it`
    //! descriptions verbatim so divergence is greppable.

    use super::*;

    mod sanitize_vm_name {
        use super::*;

        #[test]
        fn accepts_valid_names() {
            assert_eq!(sanitize_vm_name("my-vm-01").unwrap(), "my-vm-01");
        }

        #[test]
        fn accepts_underscores() {
            assert_eq!(sanitize_vm_name("test_vm").unwrap(), "test_vm");
        }

        #[test]
        fn rejects_empty_string() {
            assert!(sanitize_vm_name("").is_err());
        }

        #[test]
        fn rejects_special_characters() {
            assert!(sanitize_vm_name("vm'; rm -rf /").is_err());
        }

        #[test]
        fn rejects_spaces() {
            assert!(sanitize_vm_name("my vm").is_err());
        }

        #[test]
        fn rejects_dots() {
            assert!(sanitize_vm_name("vm.test").is_err());
        }

        #[test]
        fn rejects_names_over_100_chars() {
            let name = "a".repeat(101);
            assert!(sanitize_vm_name(&name).is_err());
        }

        #[test]
        fn rejects_names_starting_with_hyphen() {
            assert!(sanitize_vm_name("-test").is_err());
        }

        #[test]
        fn accepts_single_character_name() {
            assert_eq!(sanitize_vm_name("a").unwrap(), "a");
        }

        #[test]
        fn accepts_exactly_100_character_name() {
            let mut name = String::from("a");
            name.push_str(&"b".repeat(99));
            assert_eq!(sanitize_vm_name(&name).unwrap(), name);
        }

        #[test]
        fn accepts_numeric_only_names() {
            assert_eq!(sanitize_vm_name("12345").unwrap(), "12345");
        }
    }

    mod sanitize_label {
        use super::*;

        #[test]
        fn accepts_valid_labels_with_spaces() {
            assert_eq!(
                sanitize_label("my checkpoint 1").unwrap(),
                "my checkpoint 1"
            );
        }

        #[test]
        fn rejects_powershell_injection() {
            assert!(sanitize_label("'; Remove-Item /; '").is_err());
        }

        #[test]
        fn rejects_labels_over_200_chars() {
            let label = "a".repeat(201);
            assert!(sanitize_label(&label).is_err());
        }

        #[test]
        fn rejects_empty_string() {
            assert!(sanitize_label("").is_err());
        }

        #[test]
        fn accepts_hyphens_and_underscores() {
            assert_eq!(
                sanitize_label("before-test_run").unwrap(),
                "before-test_run"
            );
        }

        #[test]
        fn rejects_labels_starting_with_space() {
            assert!(sanitize_label(" leading space").is_err());
        }
    }

    mod sanitize_path_tests {
        use super::*;

        #[test]
        fn accepts_normal_paths() {
            assert_eq!(
                sanitize_path("C:\\Users\\test\\file.txt").unwrap(),
                "C:\\Users\\test\\file.txt"
            );
        }

        #[test]
        fn rejects_null_bytes() {
            assert!(sanitize_path("file\0.txt").is_err());
        }

        #[test]
        fn rejects_powershell_chars() {
            assert!(sanitize_path("$(evil)").is_err());
        }

        #[test]
        fn rejects_backticks() {
            assert!(sanitize_path("file`test").is_err());
        }

        #[test]
        fn rejects_single_quotes() {
            assert!(sanitize_path("file'test").is_err());
        }

        #[test]
        fn rejects_semicolons() {
            assert!(sanitize_path("C:\\path;evil").is_err());
        }

        #[test]
        fn rejects_pipe_characters() {
            assert!(sanitize_path("file|evil").is_err());
        }

        #[test]
        fn rejects_at_signs() {
            assert!(sanitize_path("@evil").is_err());
        }

        #[test]
        fn rejects_curly_braces() {
            assert!(sanitize_path("file{test}").is_err());
        }

        #[test]
        fn rejects_double_quotes() {
            assert!(sanitize_path("C:\\path\\\"$evil\"").is_err());
            assert!(sanitize_path("\"test\"").is_err());
        }

        #[test]
        fn accepts_forward_slashes() {
            assert_eq!(sanitize_path("C:/Users/test").unwrap(), "C:/Users/test");
        }
    }

    mod sanitize_command_tests {
        use super::*;

        #[test]
        fn accepts_normal_commands() {
            assert_eq!(sanitize_command("powershell").unwrap(), "powershell");
        }

        #[test]
        fn rejects_semicolons() {
            assert!(sanitize_command("cmd; evil").is_err());
        }

        #[test]
        fn rejects_pipe() {
            assert!(sanitize_command("cmd | evil").is_err());
        }

        #[test]
        fn rejects_ampersand() {
            assert!(sanitize_command("cmd & evil").is_err());
        }

        #[test]
        fn rejects_null_bytes() {
            assert!(sanitize_command("cmd\0evil").is_err());
        }

        #[test]
        fn rejects_backtick() {
            assert!(sanitize_command("cmd`evil").is_err());
        }

        #[test]
        fn rejects_dollar_sign() {
            assert!(sanitize_command("$evil").is_err());
        }

        #[test]
        fn accepts_hyphenated_commands() {
            assert_eq!(sanitize_command("Get-Process").unwrap(), "Get-Process");
        }
    }

    mod escape_powershell_arg_tests {
        use super::*;

        #[test]
        fn passes_plain_strings_through() {
            assert_eq!(escape_powershell_arg("hello"), "hello");
        }

        #[test]
        fn escapes_single_quotes_by_doubling() {
            assert_eq!(escape_powershell_arg("it's"), "it''s");
        }

        #[test]
        fn handles_multiple_quotes() {
            assert_eq!(escape_powershell_arg("a'b'c"), "a''b''c");
        }

        #[test]
        fn handles_empty_string() {
            assert_eq!(escape_powershell_arg(""), "");
        }

        #[test]
        fn handles_string_of_only_quotes() {
            assert_eq!(escape_powershell_arg("'''"), "''''''");
        }

        #[test]
        fn does_not_modify_double_quotes() {
            assert_eq!(escape_powershell_arg("\"hello\""), "\"hello\"");
        }
    }

    mod sanitize_url_tests {
        use super::*;

        #[test]
        fn accepts_https_urls() {
            assert_eq!(
                sanitize_url("https://example.com/file.exe").unwrap(),
                "https://example.com/file.exe"
            );
        }

        #[test]
        fn accepts_http_urls() {
            assert_eq!(
                sanitize_url("http://example.com/file.exe").unwrap(),
                "http://example.com/file.exe"
            );
        }

        #[test]
        fn rejects_file_urls() {
            assert!(sanitize_url("file:///etc/passwd").is_err());
        }

        #[test]
        fn rejects_ftp_urls() {
            assert!(sanitize_url("ftp://evil.com/file").is_err());
        }

        #[test]
        fn rejects_non_url_strings() {
            assert!(sanitize_url("not a url").is_err());
        }

        #[test]
        fn rejects_javascript_protocol() {
            assert!(sanitize_url("javascript:alert(1)").is_err());
        }

        #[test]
        fn rejects_data_urls() {
            assert!(sanitize_url("data:text/html,<h1>hi</h1>").is_err());
        }

        #[test]
        fn accepts_urls_with_query_strings() {
            assert_eq!(
                sanitize_url("https://example.com/file?v=1").unwrap(),
                "https://example.com/file?v=1"
            );
        }
    }

    mod sanitize_timeout_tests {
        use super::*;

        #[test]
        fn returns_default_30000_for_none() {
            assert_eq!(sanitize_timeout_default(None), 30_000);
        }

        #[test]
        fn accepts_valid_timeout_within_range() {
            assert_eq!(sanitize_timeout_default(Some(30_000)), 30_000);
        }

        #[test]
        fn clamps_below_minimum_values_up_to_1000() {
            assert_eq!(sanitize_timeout_default(Some(500)), 1_000);
            assert_eq!(sanitize_timeout_default(Some(0)), 1_000);
        }

        #[test]
        fn clamps_above_max_values_down_to_max() {
            assert_eq!(sanitize_timeout_default(Some(700_000)), 600_000);
            assert_eq!(sanitize_timeout_default(Some(999_999)), 600_000);
        }

        #[test]
        fn accepts_custom_max_and_clamps_accordingly() {
            assert_eq!(sanitize_timeout(Some(500_000), 600_000), 500_000);
            assert_eq!(sanitize_timeout(Some(400_000), 300_000), 300_000);
        }

        #[test]
        fn accepts_exactly_the_min_boundary() {
            assert_eq!(sanitize_timeout_default(Some(1_000)), 1_000);
        }

        #[test]
        fn accepts_exactly_the_max_boundary() {
            assert_eq!(sanitize_timeout_default(Some(600_000)), 600_000);
        }
    }
}
