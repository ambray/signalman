//! Build script for the Signalman Guest Agent.
//!
//! Compiles Protocol Buffer definitions via `tonic-build` to generate
//! message types and gRPC server stubs. Uses `protoc-bin-vendored` to
//! provide a pre-built `protoc` binary without system-level installation.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .map_err(|e| format!("Failed to locate vendored protoc: {e}"))?;
    std::env::set_var("PROTOC", protoc);

    tonic_build::compile_protos("../proto/guest.proto")?;
    Ok(())
}
