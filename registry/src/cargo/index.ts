/**
 * Public surface of the cargo facade (WS6 wave-3 M10).
 *
 * The cargo facade lets operators publish + install Rust crates
 * to/from a Signalman registry using stock `cargo` clients (the
 * sparse-index protocol, Cargo 1.68+).
 *
 * Multi-tenancy: every cargo route is org-namespaced under
 * `/cargo/<org>/`. An org's sparse index is opaque to other orgs;
 * operators configure `.cargo/config.toml` per-org.
 *
 * Storage backing: cargo crates land in the shared
 * `RegistryStorage` as manifests with `kind: 'cargo'` and
 * `name: 'cargo/<org>/<crate>'`. The .crate tarball is a regular
 * content-addressed blob; sparse-index JSON is rebuilt from the
 * manifest's `cargoMetadata` field on every request (cheap;
 * O(versions-of-this-crate)).
 *
 * Phased delivery:
 *   M10.2 (this file): read path — config.json, sparse-index
 *                       entries, download.
 *   M10.3 (next):       publish + yank + unyank.
 *   M10.4:              virtual registry pull-through with
 *                       re-signing for crates.io / private mirrors.
 */

export {
  validateCargoCrateName,
  validateCargoOrgName,
  sparseIndexPathFor,
  crateNameFromSparseIndexPath,
  cargoManifestName,
} from "./paths.js";

export {
  mountCargoReadRoutes,
  serializeIndexEntry,
  type MountCargoReadOptions,
} from "./read.js";
