# Signalman Development Roadmap

**Last Updated**: 2026-04-11
**Current Version**: Pre-release (v0.0.x)
**Target**: v0.1.0 (first public release)

This roadmap organizes all 33 audit findings and planned features into phased work. Phases 1 and 2 are blockers for v0.1.0. Phases 3-5 follow in priority order.

---

## Phase 1: Security Critical (MUST before v0.1.0)

**Estimated Duration**: 3-4 days
**Priority**: BLOCKER

All command injection, input validation, and default-insecure findings must be resolved before any external usage. A single unescaped VM name can give an attacker full PowerShell execution on the host.

### 1.1 Command Injection Prevention (7 findings)

The most severe class of bugs. Every hypervisor backend and the MCP server itself interpolate untrusted strings directly into shell commands.

| ID | Severity | File | Description |
|----|----------|------|-------------|
| S-1 | CRITICAL | `host/src/hypervisors/hyperv.ts` | PowerShell injection via VM name interpolation |
| S-2 | CRITICAL | `host/src/hypervisors/hyperv.ts` | Command injection in `executeCommand` via string interpolation |
| S-3 | CRITICAL | `host/src/hypervisors/hyperv.ts` | Checkpoint label injection into PowerShell scripts |
| S-4 | CRITICAL | `host/src/hypervisors/hyperv.ts` | Path traversal via `copyFileToVM` — no path restriction |
| S-5 | CRITICAL | `host/src/server.ts` | URL injection in `vm_install` direct mode |
| S-6 | CRITICAL | `host/src/hypervisors/vmware.ts` | Guest credentials stored in cleartext class fields; command injection in vmrun |
| S-12 | HIGH | `host/src/server.ts` | `vm_copy_file` accepts arbitrary guest paths without restriction |
| S-13 | HIGH | `host/src/server.ts` | Scenario loader performs no path validation (path traversal) |

**Fix strategy**:

1. Create a shared `host/src/sanitize.ts` module with:
   - `sanitizeVmName(name: string): string` — strict regex `^[a-zA-Z0-9_-]+$`, max 100 chars
   - `sanitizePath(path: string): string` — resolve, normalize, verify within allowed roots
   - `sanitizeLabel(label: string): string` — alphanumeric + dashes only
   - `sanitizeUrl(url: string): string` — validate URL parse, restrict to http/https schemes

2. Replace all PowerShell string interpolation with `-ArgumentList` parameter passing:
   ```typescript
   // BEFORE (vulnerable)
   exec(`powershell -Command "Get-VM -Name '${vmName}'"`)

   // AFTER (safe)
   exec(`powershell -Command "& { param($Name) Get-VM -Name $Name }" -ArgumentList "${sanitizeVmName(vmName)}"`)
   ```

3. Replace vmrun string interpolation with proper argument array passing.

4. Add path validation to `vm_copy_file` and scenario loader — resolve paths, verify they start with an allowed prefix.

5. Move VMware guest credentials to a secure store or environment variables; never pass as CLI arguments.

6. Validate all MCP tool inputs at the Zod schema level before they reach any hypervisor backend.

### 1.2 Input Validation (3 findings)

| ID | Severity | File | Description |
|----|----------|------|-------------|
| S-20 | MEDIUM | multiple | VM name has no format validation at the MCP tool level |
| S-21 | MEDIUM | multiple | No upper bound on timeout parameters (can block indefinitely) |
| S-22 | MEDIUM | `host/src/assertions.ts` | Regex DoS in assertion evaluator (user-supplied patterns) |

**Fix strategy**:

1. Add Zod schema constraints to all MCP tool definitions:
   ```typescript
   vmName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
   timeout: z.number().int().min(1000).max(600_000).default(30_000)
   ```

2. Wrap user-supplied regex patterns in a try/catch with a timeout, or use a safe regex library (e.g., `re2`) to prevent catastrophic backtracking.

### 1.3 Guest Agent Default Security (2 findings)

| ID | Severity | File | Description |
|----|----------|------|-------------|
| S-8 | HIGH | `guest/src/main.rs` | gRPC server defaults to insecure (no TLS) |
| S-9 | HIGH | `guest/src/main.rs` | Guest agent binds `0.0.0.0` by default |

**Fix strategy**:

1. Change default bind address to `127.0.0.1:50051`.
2. Make TLS the default. Require an explicit `--allow-insecure` flag or `allowInsecure: true` config to disable TLS.
3. Log a warning at startup when running in insecure mode.

---

## Phase 2: Test Coverage (MUST before v0.1.0)

**Estimated Duration**: 3-4 days
**Priority**: BLOCKER

The project currently has zero TypeScript tests and minimal Rust tests. No release should ship without baseline coverage of security-critical paths.

### 2.1 TypeScript Host Tests

| ID | Severity | Description |
|----|----------|-------------|
| S-11 | HIGH | Zero TypeScript tests in the host package |

**Required test suites** (vitest):

- **`sanitize.test.ts`** — Unit tests for all sanitization functions from Phase 1.1. Cover:
  - Valid inputs pass through unchanged
  - Injection payloads are rejected (PowerShell metacharacters, backticks, `$(...)`, semicolons, pipes)
  - Path traversal attempts (`../`, `..\\`, absolute paths outside allowed roots)
  - Empty strings, max-length strings, unicode edge cases

- **`config.test.ts`** — Config loading with various file/env combinations:
  - Default config when no file exists
  - File-based config override
  - Environment variable override precedence
  - Invalid config values produce clear errors

- **`assertions.test.ts`** — Assertion evaluator logic (`evaluateAssertions()`):
  - Each assertion type (contains, regex, exitCode, fileExists, etc.)
  - Regex timeout / DoS protection
  - Malformed assertion objects

- **`narrative.test.ts`** — Narrative parser (`parseNarrative()`):
  - Valid markdown with steps, assertions, metadata
  - Empty/malformed input
  - Edge cases (no steps, duplicate IDs)

- **`tool-blocks.test.ts`** — Tool block extractor (`extractToolBlocks()`):
  - Standard tool call extraction
  - Nested blocks, malformed blocks

- **`reporter.test.ts`** — JUnit reporter:
  - XML escaping of special characters (`<`, `>`, `&`, `"`, `'`)
  - Empty test suites, failed tests, skipped tests

- **`hyperv.test.ts`** — PowerShell command generation (integration with mocked exec):
  - Verify generated commands use `-ArgumentList` (post Phase 1.1 fix)
  - Verify no raw string interpolation of user input

### 2.2 Rust Guest Tests

- **`process.rs`** — `start_process` / `stop_process` / `list_processes` with mocked OS calls
- **`file.rs`** — `test_file_access` destructive write mode safety (must not corrupt existing files)
- **`network.rs`** — Network connectivity edge cases (timeout, DNS failure, unreachable host)
- **`verification.rs`** — Restriction verification logic

### 2.3 CI Pipeline Fixes

| ID | Severity | Description |
|----|----------|-------------|
| S-28 | MEDIUM | CI missing lint/test/fmt steps |

**Required CI additions**:

- `npx eslint . --quiet` for the host package
- `npx vitest run` for TypeScript tests
- `cargo fmt --check` for the guest crate
- `cargo clippy -- -D warnings` for the guest crate (Linux cross-compile)
- Coverage reporting with minimum threshold (target: 80%)

---

## Phase 3: Functional Completion

**Estimated Duration**: 5-7 days
**Priority**: HIGH

### 3.1 Guest Agent gRPC Implementation

| ID | Severity | Description |
|----|----------|-------------|
| S-10 | HIGH | Guest agent gRPC RPCs not implemented |

Implement all RPCs defined in `proto/guest.proto`:

- **Health**: `Ping`, `GetSystemInfo`
- **Process**: `StartProcess`, `StopProcess`, `ListProcesses`, `RunCommand`
- **File**: `ReadFile`, `WriteFile`, `TestFileAccess`, `ListDirectory`
- **UI Automation**: `FindWindow`, `ClickElement`, `TypeText`, `TakeScreenshot` (Windows-only; return `Unimplemented` on Linux)
- **Browser**: `NavigateTo`, `GetPageContent`
- **Verification**: `CheckRestriction`, `VerifySoftwareInstalled`
- **Software**: `InstallSoftware`, `UninstallSoftware`

Each RPC must:
- Validate all input fields
- Return proper gRPC status codes (not panics)
- Log structured events via `tracing`

### 3.1a Silo Validation Scenarios (DONE)

Three new test scenarios have been added to `scenarios/`:

- **`silo-validation/`** — Validates Windows Server Silo kernel APIs on Windows 11. Deploys a validation binary that exercises silo creation, process assignment (suspended vs running), handle isolation, ETW visibility from silo'd processes, and AppContainer + Silo composition.
- **`silo-validation-server2022/`** — Duplicate of the above targeting a Windows Server 2022 VM (`template: windows-server-2022`, `static_ip: 172.30.0.20`). Server 2022 is the primary production target for silo-based sandboxing.
- **`sandbox-enforcement/`** — Full E2E scenario that installs Cursor IDE, deploys a sandbox policy, and validates that Cursor runs inside a silo with network restrictions on AI endpoints while core IDE features remain operational.

**Server 2022 VM support**: Currently implemented as a duplicate scenario directory with a different VM template and IP. A proper matrix-based approach (single scenario definition, multiple VM targets) is deferred to Phase 4 or later.

### 3.2 Code Architecture Cleanup

| ID | Severity | Description |
|----|----------|-------------|
| S-23 | MEDIUM | Triplicated `vmCache` code across `tools/*.ts` |
| S-24 | MEDIUM | Dual tool registration — `server.ts` inline vs `tools/` definitions |
| S-29 | LOW | Narrative parser module exists but is never called |
| S-30 | LOW | Reporter module exists but is never called |

**Tasks**:

1. Extract `vmCache` into a shared `host/src/vm-cache.ts` module. All tool files import from there.
2. Resolve dual tool registration: either wire the `tools/` system into `server.ts` or remove the dead `tools/` directory. Do not ship both.
3. Wire the narrative parser and JUnit reporter into the scenario runner so they are actually used.
4. Remove any remaining dead code paths.

### 3.3 Resource Leak Fixes

| ID | Severity | File | Description |
|----|----------|------|-------------|
| S-17 | MEDIUM | `guest/src/process.rs` | Child process handle leaked — not stored in registry |
| S-18 | MEDIUM | `guest/src/process.rs` | Windows `HANDLE` not closed in `stop_process` |
| S-19 | MEDIUM | `guest/src/verification.rs` | `test_file_access` write mode can corrupt existing files |

**Fix strategy**:

1. Store all spawned `Child` handles in a `HashMap<u32, Child>` process registry. Clean up on `stop_process` or agent shutdown.
2. On Windows, ensure `CloseHandle` is called after `OpenProcess` + `TerminateProcess` in `stop_process`. Use a RAII wrapper.
3. In `test_file_access`, use `OpenOptions::new().create_new(true)` for write tests (fails if file exists) or write to a temporary file and delete it. Never overwrite existing files.

---

## Phase 4: Production Hardening

**Estimated Duration**: 3-4 days
**Priority**: MEDIUM

### 4.1 Authentication and Authorization

| ID | Severity | Description |
|----|----------|-------------|
| S-7 | HIGH | MCP server has zero authentication |
| S-15 | MEDIUM | gRPC client has no timeout or retry logic |
| S-16 | MEDIUM | gRPC client connection resource leak |

**Tasks**:

1. Document the MCP security model clearly: stdio transport = trusted (inherits caller's identity), network transport = requires authentication.
2. Add a VM allow-list configuration so MCP tools can only target approved VMs.
3. Add connection timeout (default 10s) and retry logic (3 retries with exponential backoff) to the gRPC client.
4. Ensure gRPC client connections are properly closed on error and on `dispose()`.
5. Implement guest agent mTLS enforcement: guest checks client certificate against a trusted CA.

### 4.2 Credential Management

| ID | Severity | Description |
|----|----------|-------------|
| S-6 | CRITICAL | VMware guest credentials in cleartext class fields (also addressed in 1.1) |
| S-25 | MEDIUM | Unsafe `any` casting for proto message construction |

**Tasks**:

1. Move VMware credentials to environment variables or a credential store (Windows Credential Manager / keyring).
2. Document that passwords must never be passed as CLI arguments (visible in process listing).
3. Replace `any` casts in proto message construction with properly typed builders.

### 4.3 Certificate Improvements

| ID | Severity | Description |
|----|----------|-------------|
| S-26 | MEDIUM | RSA 2048 below current recommendations |
| S-27 | MEDIUM | 365-day certificate with no renewal mechanism |
| S-33 | LOW | Hardcoded `172.30.0.x` IPs in certificate SANs |

**Tasks**:

1. Upgrade certificate generation from RSA 2048 to ECDSA P-256 (or Ed25519 where supported).
2. Make SAN IPs configurable via config file or CLI flags instead of hardcoded `172.30.0.x`.
3. Add certificate expiry warning: log a warning at startup if the cert expires within 30 days.
4. Implement ACME-based renewal (replace the existing stub) or at minimum a `signalman certs renew` CLI command.

### 4.4 Error Handling

| ID | Severity | Description |
|----|----------|-------------|
| S-14 | MEDIUM | `psJson()` swallows PowerShell stdout on JSON parse failure |

**Tasks**:

1. In `psJson()`, include the original stdout (truncated to 1KB) in JSON parse error messages for debuggability.
2. Add a default 30-second deadline on all unary gRPC calls from the host to the guest.
3. In the scenario loader, validate file paths by resolving them and checking they start with the scenarios directory.

---

## Phase 5: API and Protocol Improvements

**Estimated Duration**: 2-3 days
**Priority**: LOW

### 5.1 Proto Enhancements

| ID | Severity | Description |
|----|----------|-------------|
| S-31 | LOW | `ProcessStartResponse` overloaded for fire-and-forget vs wait modes |
| S-32 | LOW | No server-streaming RPCs for long-running commands |

**Tasks**:

1. Split `ProcessStartResponse` into two response types:
   - `ProcessStartResponse` for fire-and-forget (returns PID only)
   - `ProcessRunResponse` for wait mode (returns PID + exit code + stdout/stderr)

2. Add `RunCommandStream` server-streaming RPC for long-running commands that need incremental output.

3. Add proper error response types with structured error codes rather than relying solely on gRPC status.

### 5.2 Async and Performance

**Tasks**:

1. Convert `GuestClient` constructor to an async factory method pattern:
   ```typescript
   // BEFORE
   const client = new GuestClient(address); // blocks, no error handling

   // AFTER
   const client = await GuestClient.connect(address, { timeout: 10_000 });
   ```

2. Add connection timeout and retry configuration to `GuestClient.connect()`.

3. Consider async file I/O in config loading (non-blocking startup).

---

## Timeline Summary

| Phase | Duration | Priority | Gate |
|-------|----------|----------|------|
| Phase 1: Security Critical | 3-4 days | BLOCKER | Must pass before v0.1.0 |
| Phase 2: Test Coverage | 3-4 days | BLOCKER | Must pass before v0.1.0 |
| Phase 3: Functional Completion | 5-7 days | HIGH | Should complete for v0.1.0 |
| Phase 4: Production Hardening | 3-4 days | MEDIUM | Target v0.2.0 |
| Phase 5: Protocol Improvements | 2-3 days | LOW | Target v0.3.0 |

**Total estimated effort**: 16-22 days

---

## Finding Cross-Reference

Complete index of all 33 audit findings, sorted by ID.

| ID | Severity | Phase | File(s) | Description |
|----|----------|-------|---------|-------------|
| S-1 | CRITICAL | 1.1 | `host/src/hypervisors/hyperv.ts` | PowerShell injection via VM name interpolation |
| S-2 | CRITICAL | 1.1 | `host/src/hypervisors/hyperv.ts` | Command injection in `executeCommand` string interpolation |
| S-3 | CRITICAL | 1.1 | `host/src/hypervisors/hyperv.ts` | Checkpoint label injection into PowerShell scripts |
| S-4 | CRITICAL | 1.1 | `host/src/hypervisors/hyperv.ts` | Path traversal via `copyFileToVM` with no restrictions |
| S-5 | CRITICAL | 1.1 | `host/src/server.ts` | URL injection in `vm_install` direct mode |
| S-6 | CRITICAL | 1.1, 4.2 | `host/src/hypervisors/vmware.ts` | Guest credentials in cleartext class fields |
| S-7 | HIGH | 4.1 | `host/src/server.ts` | MCP server has zero authentication |
| S-8 | HIGH | 1.3 | `guest/src/main.rs` | gRPC server defaults to insecure (no TLS) |
| S-9 | HIGH | 1.3 | `guest/src/main.rs` | Guest agent binds `0.0.0.0` by default |
| S-10 | HIGH | 3.1 | `guest/src/` | Guest agent gRPC RPCs not implemented |
| S-11 | HIGH | 2.1 | `host/` | Zero TypeScript tests in host package |
| S-12 | HIGH | 1.1 | `host/src/server.ts` | `vm_copy_file` accepts arbitrary guest paths |
| S-13 | HIGH | 1.1 | `host/src/server.ts` | Scenario loader performs no path validation |
| S-14 | MEDIUM | 4.4 | `host/src/hypervisors/hyperv.ts` | `psJson()` swallows stdout on JSON parse failure |
| S-15 | MEDIUM | 4.1 | `host/src/guest/client.ts` | gRPC client has no timeout or retry logic |
| S-16 | MEDIUM | 4.1 | `host/src/guest/client.ts` | gRPC client connection resource leak |
| S-17 | MEDIUM | 3.3 | `guest/src/process.rs` | Child process handle leaked (not stored in registry) |
| S-18 | MEDIUM | 3.3 | `guest/src/process.rs` | Windows HANDLE not closed in `stop_process` |
| S-19 | MEDIUM | 3.3 | `guest/src/verification.rs` | `test_file_access` write mode can corrupt existing files |
| S-20 | MEDIUM | 1.2 | multiple | VM name has no format validation |
| S-21 | MEDIUM | 1.2 | multiple | No upper bound on timeout parameters |
| S-22 | MEDIUM | 1.2 | `host/src/assertions.ts` | Regex DoS in assertion evaluator |
| S-23 | MEDIUM | 3.2 | `host/src/tools/*.ts` | Triplicated `vmCache` code |
| S-24 | MEDIUM | 3.2 | `host/src/server.ts`, `host/src/tools/` | Dual tool registration (dead code) |
| S-25 | MEDIUM | 4.2 | `host/src/guest/client.ts` | Unsafe `any` casting for proto messages |
| S-26 | MEDIUM | 4.3 | `certs/` | RSA 2048 below current recommendations |
| S-27 | MEDIUM | 4.3 | `certs/` | 365-day certificate with no renewal mechanism |
| S-28 | MEDIUM | 2.3 | CI config | CI missing lint/test/fmt steps |
| S-29 | LOW | 3.2 | `host/src/narrative.ts` | Narrative parser module exists but is never called |
| S-30 | LOW | 3.2 | `host/src/reporter.ts` | Reporter module exists but is never called |
| S-31 | LOW | 5.1 | `proto/guest.proto` | `ProcessStartResponse` overloaded for two modes |
| S-32 | LOW | 5.1 | `proto/guest.proto` | No server-streaming RPCs for long commands |
| S-33 | LOW | 4.3 | `certs/generate.ts` | Hardcoded `172.30.0.x` IPs in certificate SANs |

---

## Severity Summary

| Severity | Count | Phases |
|----------|-------|--------|
| CRITICAL | 6 | Phase 1 |
| HIGH | 5 | Phases 1, 2, 3, 4 |
| MEDIUM | 15 | Phases 1, 2, 3, 4 |
| LOW | 4 | Phases 3, 5 |
| **Total** | **33** | |

---

## Version Milestones

### v0.1.0 — Minimum Viable Release
- All Phase 1 (security critical) findings resolved
- All Phase 2 (test coverage) findings resolved
- Phase 3 substantially complete (gRPC RPCs implemented, architecture cleaned up)
- CI pipeline running lint, test, and fmt checks

### v0.2.0 — Production Ready
- All Phase 4 (hardening) findings resolved
- mTLS enforced by default on guest agent
- Certificate management improved
- Authentication model documented and enforced

### v0.3.0 — API Stable
- All Phase 5 (protocol) improvements shipped
- Proto API considered stable
- Streaming RPCs available for long-running operations
