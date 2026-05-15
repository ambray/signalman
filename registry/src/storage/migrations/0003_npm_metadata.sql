-- v0.1.1 (npm facade) — npm-specific metadata column on manifest.
--
-- Cargo got its own `cargo_metadata_json` column in 0002. Npm
-- follows the same pattern with its own column. The Manifest's
-- `kind` discriminator tells consumers which sub-shape to read.
--
-- Future protocols (OCI, maven, pip, helm, conan) each get their
-- own column under this pattern. Number of columns grows linearly
-- with protocols but stays well-bounded (max ~6 columns per the
-- ROADMAP).
--
-- Default NULL preserves back-compat for existing rows.

ALTER TABLE manifest ADD COLUMN npm_metadata_json TEXT;
