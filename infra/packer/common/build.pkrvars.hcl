# Generated for WS6 wave-3 carve-out #4 — shared Packer variable
# defaults for the AWS / Azure / Hyper-V golden-image builds.
#
# This file is consumed via `packer build -var-file=...`. Each
# `*.pkr.hcl` template declares the same variable names; this file
# supplies cross-template defaults so a one-shot invocation only has
# to override what is environment-specific (region, subscription id,
# secret SP fields).
#
# IMPORTANT: keep this file free of secrets. Credentials must come
# from the environment (AWS_*, ARM_*, AZURE_*) or from a sibling
# `*.auto.pkrvars.hcl` that is .gitignored.

# ── Agent build inputs ────────────────────────────────────────────

# Semantic version of the guest agent baked into the image. Surfaces
# on the image as the `signalman-agent-version` tag/metadata so the
# control plane's vm_lineage_hash (v0.3.0-3) can resolve it back to a
# source ref. Override per-build via `-var 'agent_version=...'`.
agent_version = "0.2.1"

# Free-form tag stamped on the image and its manifest entry. CI sets
# this to the git short sha; operators building locally may set it to
# a release tag like `2026-05-15-golden`.
image_tag = "dev"

# Build-context-relative path to the prebuilt Linux guest binary. The
# upstream step (`cargo build --release --bin signalman-guest`) drops
# the artifact at this path; both AWS and Azure templates upload it.
linux_guest_binary = "../../../guest/target/release/signalman-guest"

# Build-context-relative path to the prebuilt Windows guest binary.
# Consumed by the Hyper-V template. Produced by
# `cargo build --release --bin signalman-guest --target x86_64-pc-windows-msvc`
# on a Windows builder.
windows_guest_binary = "../../../guest/target/release/signalman-guest.exe"

# Placeholder path to the host-side mTLS root CA cert that gets baked
# into the image so the guest agent can verify the control plane's
# cert. Operators replace this with the path to their org's CA
# bundle. The cost-reaper does not inspect this file; only the guest
# agent does, at runtime.
mtls_root_ca = "./placeholder-ca.pem"
