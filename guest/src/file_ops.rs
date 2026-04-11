//! File operations module.
//!
//! Provides file read, write, and directory listing capabilities for the
//! guest agent. These are used by the gRPC service handlers and can also
//! be invoked directly for testing and scripting.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Maximum number of bytes that `read_file` will return in a single call.
/// Prevents unbounded memory allocation from large files or protobuf-default
/// u64::MAX limits.
const MAX_READ_SIZE: u64 = 100 * 1024 * 1024; // 100 MB

/// Chunk size used when reading files with limit=0 (read-to-EOF mode).
const READ_CHUNK_SIZE: usize = 64 * 1024; // 64 KB

/// Known system directories that `write_file` will refuse to write into.
const BLOCKED_DIRECTORIES: &[&str] = &[
    "C:\\Windows",
    "C:\\windows",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
];

/// A single directory entry returned by [`list_directory`].
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DirectoryEntry {
    /// File or directory name (not the full path).
    pub name: String,
    /// Size in bytes (0 for directories).
    pub size: u64,
    /// Whether this entry is a directory.
    pub is_dir: bool,
    /// Last modified time as seconds since UNIX epoch, or 0 if unavailable.
    pub modified_secs: u64,
}

/// Read bytes from a file at the given path, starting at `offset` and
/// reading up to `limit` bytes.
///
/// # Arguments
/// * `path` - Filesystem path to read from.
/// * `offset` - Byte offset to start reading at.
/// * `limit` - Maximum number of bytes to read. Pass `0` to read the
///   entire file from the offset to EOF.
///
/// # Returns
/// The bytes read, which may be shorter than `limit` if the file is
/// smaller than `offset + limit`.
pub fn read_file(path: &str, offset: u64, limit: u64) -> anyhow::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;

    if offset > 0 {
        file.seek(SeekFrom::Start(offset))?;
    }

    if limit == 0 {
        // Read in chunks up to MAX_READ_SIZE to avoid unbounded allocation.
        let mut buf = Vec::new();
        let mut chunk = [0u8; READ_CHUNK_SIZE];
        loop {
            if buf.len() as u64 >= MAX_READ_SIZE {
                tracing::warn!(
                    path,
                    max_bytes = MAX_READ_SIZE,
                    "read_file: reached MAX_READ_SIZE cap, truncating"
                );
                break;
            }
            let remaining = (MAX_READ_SIZE - buf.len() as u64) as usize;
            let to_read = remaining.min(READ_CHUNK_SIZE);
            let n = file.read(&mut chunk[..to_read])?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok(buf)
    } else {
        // Clamp the requested limit to MAX_READ_SIZE to prevent OOM.
        let clamped = limit.min(MAX_READ_SIZE) as usize;
        if limit > MAX_READ_SIZE {
            tracing::warn!(
                path,
                requested = limit,
                clamped = clamped,
                "read_file: limit exceeds MAX_READ_SIZE, clamping"
            );
        }
        let mut buf = vec![0u8; clamped];
        let n = file.read(&mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }
}

/// Returns the workspace jail path from the `SIGNALMAN_WORKSPACE` environment
/// variable, if set. When set, `write_file` restricts writes to this directory.
fn get_workspace_jail() -> Option<PathBuf> {
    std::env::var("SIGNALMAN_WORKSPACE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Validate that `path` is safe to write to, given an optional jail directory.
///
/// Paths containing `..` components or targeting known system directories
/// are always rejected. When `jail` is `Some`, the path must resolve
/// inside that directory.
fn validate_write_path_inner(path: &str, jail: Option<&Path>) -> anyhow::Result<()> {
    // Reject path-traversal components.
    if path.contains("..") {
        anyhow::bail!("write_file: path contains '..' traversal: {path}");
    }

    // Block known system directories.
    let canonical_path_str = path.replace('\\', "/");
    for blocked in BLOCKED_DIRECTORIES {
        let blocked_normalized = blocked.replace('\\', "/");
        if canonical_path_str.starts_with(&blocked_normalized) {
            anyhow::bail!("write_file: path is inside blocked system directory {blocked}: {path}");
        }
    }

    // Workspace jail check.
    if let Some(jail) = jail {
        let target = Path::new(path);
        // Ensure parent directory exists so canonicalize works on the parent.
        let parent = target.parent().unwrap_or(Path::new("."));
        let canonical_parent = parent.canonicalize().map_err(|e| {
            anyhow::anyhow!("write_file: cannot resolve parent directory of {path}: {e}")
        })?;
        let canonical_jail = jail.canonicalize().map_err(|e| {
            anyhow::anyhow!(
                "write_file: cannot resolve SIGNALMAN_WORKSPACE '{}': {e}",
                jail.display()
            )
        })?;
        if !canonical_parent.starts_with(&canonical_jail) {
            anyhow::bail!(
                "write_file: path {path} is outside workspace jail {}",
                canonical_jail.display()
            );
        }
    } else {
        tracing::warn!(
            path,
            "write_file: SIGNALMAN_WORKSPACE not set — no path jail enforced"
        );
    }

    Ok(())
}

/// Validate that `path` is safe to write to.
///
/// Reads the jail directory from `SIGNALMAN_WORKSPACE` env var.
fn validate_write_path(path: &str) -> anyhow::Result<()> {
    let jail = get_workspace_jail();
    validate_write_path_inner(path, jail.as_deref())
}

/// Write bytes to a file. If `append` is true, data is appended;
/// otherwise the file is created or truncated.
///
/// # Path validation
/// - Paths containing `..` are always rejected.
/// - Writes to system directories (`C:\Windows`, `/etc`, `/usr`, `/bin`,
///   `/sbin`) are always rejected.
/// - When the `SIGNALMAN_WORKSPACE` environment variable is set, only
///   paths inside that directory are allowed.
///
/// # Returns
/// The number of bytes written.
pub fn write_file(path: &str, content: &[u8], append: bool) -> anyhow::Result<u64> {
    validate_write_path(path)?;

    let mut file = if append {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?
    };

    file.write_all(content)?;
    Ok(content.len() as u64)
}

/// List the entries in a directory.
///
/// Returns a vector of [`DirectoryEntry`] with name, size, type, and
/// modification time for each entry.
pub fn list_directory(path: &str) -> anyhow::Result<Vec<DirectoryEntry>> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        anyhow::bail!("path is not a directory: {path}");
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let modified_secs = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            size: metadata.len(),
            is_dir: metadata.is_dir(),
            modified_secs,
        });
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Helper: create a temp directory that is cleaned up when the guard drops.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("signalman-test-{name}-{}", rand::random::<u32>()));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_read_existing_file() {
        let dir = TempDir::new("read");
        let file_path = dir.path().join("hello.txt");
        fs::write(&file_path, b"hello world").unwrap();

        let data = read_file(file_path.to_str().unwrap(), 0, 0).unwrap();
        assert_eq!(data, b"hello world");
    }

    #[test]
    fn test_read_with_offset_and_limit() {
        let dir = TempDir::new("read-off");
        let file_path = dir.path().join("data.txt");
        fs::write(&file_path, b"abcdefghij").unwrap();

        let data = read_file(file_path.to_str().unwrap(), 3, 4).unwrap();
        assert_eq!(data, b"defg");
    }

    #[test]
    fn test_read_nonexistent_file() {
        let result = read_file("Z:\\nonexistent\\no-such-file.txt", 0, 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_write_then_read_roundtrip() {
        let dir = TempDir::new("write-rt");
        let file_path = dir.path().join("out.bin");
        let path_str = file_path.to_str().unwrap();

        let written = write_file(path_str, b"payload-123", false).unwrap();
        assert_eq!(written, 11);

        let data = read_file(path_str, 0, 0).unwrap();
        assert_eq!(data, b"payload-123");
    }

    #[test]
    fn test_write_append() {
        let dir = TempDir::new("write-ap");
        let file_path = dir.path().join("append.txt");
        let path_str = file_path.to_str().unwrap();

        write_file(path_str, b"first", false).unwrap();
        write_file(path_str, b"-second", true).unwrap();

        let data = read_file(path_str, 0, 0).unwrap();
        assert_eq!(data, b"first-second");
    }

    #[test]
    fn test_list_directory() {
        let dir = TempDir::new("listdir");
        fs::write(dir.path().join("a.txt"), b"aaa").unwrap();
        fs::write(dir.path().join("b.txt"), b"bb").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = list_directory(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 3);

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
        assert!(names.contains(&"subdir"));

        let subdir_entry = entries.iter().find(|e| e.name == "subdir").unwrap();
        assert!(subdir_entry.is_dir);

        let a_entry = entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(a_entry.size, 3);
        assert!(!a_entry.is_dir);
    }

    #[test]
    fn test_list_nonexistent_directory() {
        let result = list_directory("Z:\\nonexistent\\no-such-dir");
        assert!(result.is_err());
    }

    // --- S-09: read_file bounded allocation tests ---

    #[test]
    fn test_read_file_limit_zero_caps_at_max() {
        // Write a small file and read with limit=0 — should succeed and
        // return full content (well under MAX_READ_SIZE).
        let dir = TempDir::new("read-cap");
        let file_path = dir.path().join("small.bin");
        let content = vec![0xABu8; 1024];
        fs::write(&file_path, &content).unwrap();

        let data = read_file(file_path.to_str().unwrap(), 0, 0).unwrap();
        assert_eq!(data.len(), 1024);
        assert_eq!(data, content);
    }

    #[test]
    fn test_read_file_oversized_limit_is_clamped() {
        // Request u64::MAX bytes — should be clamped to MAX_READ_SIZE
        // and not attempt to allocate 18 exabytes.
        let dir = TempDir::new("read-clamp");
        let file_path = dir.path().join("tiny.txt");
        fs::write(&file_path, b"hello").unwrap();

        let data = read_file(file_path.to_str().unwrap(), 0, u64::MAX).unwrap();
        assert_eq!(data, b"hello");
    }

    #[test]
    fn test_read_file_normal_limit() {
        let dir = TempDir::new("read-normal");
        let file_path = dir.path().join("data.bin");
        fs::write(&file_path, b"0123456789").unwrap();

        let data = read_file(file_path.to_str().unwrap(), 0, 5).unwrap();
        assert_eq!(data, b"01234");
    }

    // --- S-10: write_file path validation tests ---

    #[test]
    fn test_write_valid_path_inside_jail() {
        let dir = TempDir::new("write-jail");
        let file_path = dir.path().join("ok.txt");
        // Validate using the inner function directly to avoid env var races.
        let result = validate_write_path_inner(file_path.to_str().unwrap(), Some(dir.path()));
        assert!(result.is_ok(), "write inside jail should succeed: {result:?}");
    }

    #[test]
    fn test_write_rejected_outside_jail() {
        let dir = TempDir::new("write-outside");
        // Try to write to temp dir root (outside our jail).
        let outside = std::env::temp_dir().join("signalman-outside-jail.txt");
        let result = validate_write_path_inner(outside.to_str().unwrap(), Some(dir.path()));
        assert!(result.is_err(), "write outside jail should be rejected");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("outside workspace jail"),
            "error should mention jail: {err_msg}"
        );
    }

    #[test]
    fn test_write_rejected_dot_dot_traversal() {
        let result = write_file("/tmp/../etc/passwd", b"bad", false);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains(".."), "error should mention traversal: {err_msg}");
    }

    #[test]
    fn test_write_rejected_system_directory() {
        let result = write_file("C:\\Windows\\evil.txt", b"bad", false);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("blocked system directory"),
            "error should mention blocked dir: {err_msg}"
        );

        let result2 = write_file("/etc/shadow", b"bad", false);
        assert!(result2.is_err());
    }
}
