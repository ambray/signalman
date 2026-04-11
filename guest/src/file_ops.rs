//! File operations module.
//!
//! Provides file read, write, and directory listing capabilities for the
//! guest agent. These are used by the gRPC service handlers and can also
//! be invoked directly for testing and scripting.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

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
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        Ok(buf)
    } else {
        let mut buf = vec![0u8; limit as usize];
        let n = file.read(&mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }
}

/// Write bytes to a file. If `append` is true, data is appended;
/// otherwise the file is created or truncated.
///
/// # Returns
/// The number of bytes written.
pub fn write_file(path: &str, content: &[u8], append: bool) -> anyhow::Result<u64> {
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
}
