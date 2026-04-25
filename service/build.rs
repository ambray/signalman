//! Build script for signalman-service.
//!
//! Compiles the Protocol Buffer definition via tonic-build, using a
//! vendored protoc binary so no system-level install is required.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .map_err(|e| format!("Failed to locate vendored protoc: {e}"))?;
    std::env::set_var("PROTOC", protoc);

    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&["proto/signalman_service.proto"], &["proto"])?;
    Ok(())
}
