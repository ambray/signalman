/**
 * v0.5 Win11 M2 — Unattended.xml composer.
 *
 * Builds a Windows Setup unattended-installation file (the
 * `Autounattend.xml` Windows looks for on removable media at first
 * boot) from a strongly-typed {@link UnattendedConfig}. Output is
 * deterministic — given the same input, the same bytes — and
 * UTF-8 BOM-prefixed as Microsoft requires.
 *
 * Locked design (M0 §5/§6):
 *   - One unattended pass `specialize` (ComputerName, TimeZone,
 *     RegisteredOwner/Organization, RDP enable) + `oobeSystem`
 *     (skip EULA / local-account / online-account screens, hide
 *     wireless setup, ProtectYourPC=3, local-admin account, auto-
 *     logon, FirstLogonCommand writing the readiness sentinel).
 *   - Q4 (RDP): enabled by default. Q5 (FirstLogonCommands):
 *     sentinel file. Q6 (ComputerName): transliterated NetBIOS-15.
 *     Q8 (TimeZone): IANA -> MS display name.
 *
 * The composer also exposes a minimal {@link parseAutounattendXml}
 * for round-trip testing — the parser is NOT load-bearing in the
 * pipeline; it exists so the test suite can verify
 * compose(parse(compose(x))) === compose(x).
 *
 * Microsoft schema compliance:
 *   - `<?xml version="1.0" encoding="utf-8"?>` declaration first.
 *   - UTF-8 BOM prefix (the Windows Setup XML processor requires
 *     it; without the BOM, the file is silently ignored).
 *   - Top-level `<unattend
 *     xmlns="urn:schemas-microsoft-com:unattend">`.
 *   - Each settings block has `pass="specialize|oobeSystem"`.
 *   - Components carry the canonical `name`, `processorArchitecture`,
 *     `publicKeyToken`, `language`, `versionScope` attributes.
 *
 * What we deliberately DON'T do:
 *   - `windowsPE` pass — the template is already-installed.
 *   - `UnattendedJoin` (domain join is non-goal per the design
 *     doc).
 *   - `OEMInformation` (non-goal).
 *   - Static IP / DNS overrides (network from scenario).
 */

import {
  toNetbiosComputerName,
  type NetbiosComputerNameResult,
} from "./unattended-computer-name.js";
import { resolveTimeZoneForUnattended } from "./unattended-timezone.js";

// ── Public types ──────────────────────────────────────────────────

/**
 * Strongly-typed configuration for {@link composeAutounattendXml}.
 *
 * The composer is deterministic + side-effect-free; all values
 * required for the emitted XML must be supplied here. Optional
 * fields fall back to the M0 locked defaults documented inline.
 */
export interface UnattendedConfig {
  /**
   * VM ComputerName source. Will be transliterated to a NetBIOS-15
   * friendly value via {@link toNetbiosComputerName}. Required.
   */
  computerName: string;
  /**
   * Local administrator credentials for the OOBE auto-creation
   * step. The password is entity-encoded; any printable characters
   * are safe.
   */
  adminUsername: string;
  adminPassword: string;
  /**
   * Locale tag used for the `<UILanguage>` / `<InputLocale>` /
   * `<SystemLocale>` / `<UserLocale>` quadruple. Defaults to
   * `"en-US"`. Operators wanting other locales pass them verbatim;
   * we don't translate.
   */
  locale?: string;
  /**
   * Timezone — accepts either an IANA name (`America/Los_Angeles`)
   * or a Microsoft display name (`Pacific Standard Time`). IANA is
   * translated via the static lookup table.
   * Defaults to `"UTC"`.
   */
  timezone?: string;
  /**
   * Auto-logon count — number of automatic admin logons before
   * the OS reverts to the lock screen. Q2 locked default: 3
   * (enough for the testsigning reboot + MSI install cycle).
   */
  autoLogonCount?: number;
  /**
   * Enable Remote Desktop at first boot. Q4 locked default: true
   * (this is a test/demo VM and the operator may want to RDP in
   * for debugging).
   */
  enableRDP?: boolean;
  /**
   * `OOBE/ProtectYourPC` value: 1=recommended-settings,
   * 3=no-pitch. Q3 locked default: 3.
   */
  protectYourPC?: 1 | 3;
  /**
   * `<RegisteredOwner>` — defaults to "signalman".
   */
  registeredOwner?: string;
  /**
   * `<RegisteredOrganization>` — defaults to "signalman".
   */
  registeredOrganization?: string;
  /**
   * FirstLogonCommands description override. Defaults to the
   * sentinel-file pattern (Q5 locked).
   */
  firstLogonCommand?: {
    description: string;
    commandLine: string;
  };
}

/**
 * Diagnostic metadata about a composed XML. Exposed for the
 * pipeline so it can log e.g. the ComputerName rewrite.
 */
export interface UnattendedComposeMeta {
  computerName: NetbiosComputerNameResult;
  timezone: { source: string; resolved: string };
  locale: string;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIMEZONE = "UTC";
/** Q2 locked default. */
const DEFAULT_AUTO_LOGON_COUNT = 3;
/** Q4 locked default. */
const DEFAULT_ENABLE_RDP = true;
/** Q3 locked default. */
const DEFAULT_PROTECT_YOUR_PC: 1 | 3 = 3;
const DEFAULT_REGISTERED_OWNER = "signalman";
const DEFAULT_REGISTERED_ORG = "signalman";
/**
 * Q5 locked default: sentinel file under C:\ that the host's
 * heartbeat waiter can stat to detect "OOBE done, desktop up".
 * The trailing flush is implicit — `echo > file` in CMD writes the
 * full payload before returning, and Windows's filesystem cache
 * flushes within the FirstLogonCommands gate.
 */
const DEFAULT_FIRST_LOGON_DESCRIPTION = "signalman: signal readiness";
const DEFAULT_FIRST_LOGON_COMMAND_LINE =
  'cmd.exe /c "echo ready > C:\\signalman-ready.txt"';

/** UTF-8 BOM (EF BB BF). Required by the Windows Setup XML processor. */
const UTF8_BOM = "﻿";

// ── Compose ───────────────────────────────────────────────────────

/**
 * Compose an Autounattend.xml document from `cfg`.
 *
 * Returns the document as a UTF-8 BOM-prefixed string. Caller is
 * responsible for writing it to disk + including it in the seed
 * ISO under the name `Autounattend.xml` (Microsoft's
 * sysprep-on-removable-media convention).
 */
export function composeAutounattendXml(cfg: UnattendedConfig): string {
  return composeWithMeta(cfg).xml;
}

/**
 * Like {@link composeAutounattendXml} but also returns the
 * computed metadata (post-transliteration ComputerName, resolved
 * MS timezone display name, locale). The pipeline uses this to
 * log "we rewrote 'my.vm.example' to 'my-vm-example'".
 */
export function composeWithMeta(cfg: UnattendedConfig): {
  xml: string;
  meta: UnattendedComposeMeta;
} {
  if (typeof cfg !== "object" || cfg === null) {
    throw new TypeError("composeAutounattendXml: cfg must be an object");
  }
  if (typeof cfg.computerName !== "string" || cfg.computerName.length === 0) {
    throw new Error(
      "composeAutounattendXml: cfg.computerName must be a non-empty string",
    );
  }
  if (typeof cfg.adminUsername !== "string" || cfg.adminUsername.length === 0) {
    throw new Error(
      "composeAutounattendXml: cfg.adminUsername must be a non-empty string",
    );
  }
  if (typeof cfg.adminPassword !== "string") {
    throw new Error(
      "composeAutounattendXml: cfg.adminPassword must be a string",
    );
  }

  const computer = toNetbiosComputerName(cfg.computerName);
  const localeSource = cfg.locale ?? DEFAULT_LOCALE;
  const tzSource = cfg.timezone ?? DEFAULT_TIMEZONE;
  const tzResolved = resolveTimeZoneForUnattended(tzSource);
  const autoLogonCount = cfg.autoLogonCount ?? DEFAULT_AUTO_LOGON_COUNT;
  if (!Number.isInteger(autoLogonCount) || autoLogonCount < 1) {
    throw new Error(
      `composeAutounattendXml: autoLogonCount must be a positive integer ` +
        `(got ${cfg.autoLogonCount})`,
    );
  }
  const enableRDP = cfg.enableRDP ?? DEFAULT_ENABLE_RDP;
  const protectYourPC = cfg.protectYourPC ?? DEFAULT_PROTECT_YOUR_PC;
  const registeredOwner = cfg.registeredOwner ?? DEFAULT_REGISTERED_OWNER;
  const registeredOrg =
    cfg.registeredOrganization ?? DEFAULT_REGISTERED_ORG;
  const firstLogon = cfg.firstLogonCommand ?? {
    description: DEFAULT_FIRST_LOGON_DESCRIPTION,
    commandLine: DEFAULT_FIRST_LOGON_COMMAND_LINE,
  };

  const xml = renderUnattended({
    computerName: computer.result,
    locale: localeSource,
    tzMs: tzResolved,
    adminUsername: cfg.adminUsername,
    adminPassword: cfg.adminPassword,
    autoLogonCount,
    enableRDP,
    protectYourPC,
    registeredOwner,
    registeredOrg,
    firstLogon,
  });

  return {
    xml,
    meta: {
      computerName: computer,
      timezone: { source: tzSource, resolved: tzResolved },
      locale: localeSource,
    },
  };
}

// ── Internal renderer ─────────────────────────────────────────────

interface RenderInput {
  computerName: string;
  locale: string;
  tzMs: string;
  adminUsername: string;
  adminPassword: string;
  autoLogonCount: number;
  enableRDP: boolean;
  protectYourPC: 1 | 3;
  registeredOwner: string;
  registeredOrg: string;
  firstLogon: { description: string; commandLine: string };
}

/**
 * Render the canonical Autounattend.xml. The output layout is
 * intentionally rigid (two-space indents, specific element order)
 * so we get deterministic bytes — tests assert byte equality.
 */
function renderUnattended(r: RenderInput): string {
  const e = encodeXmlEntity;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<unattend xmlns="urn:schemas-microsoft-com:unattend">');

  // ── specialize pass ───────────────────────────────────────────
  lines.push('  <settings pass="specialize">');
  lines.push(componentOpen("Microsoft-Windows-Shell-Setup"));
  lines.push(`      <ComputerName>${e(r.computerName)}</ComputerName>`);
  lines.push(`    <RegisteredOwner>${e(r.registeredOwner)}</RegisteredOwner>`);
  lines.push(
    `    <RegisteredOrganization>${e(r.registeredOrg)}</RegisteredOrganization>`,
  );
  lines.push(`    <TimeZone>${e(r.tzMs)}</TimeZone>`);
  lines.push("    </component>");

  if (r.enableRDP) {
    lines.push(
      componentOpen("Microsoft-Windows-TerminalServices-LocalSessionManager"),
    );
    lines.push("      <fDenyTSConnections>false</fDenyTSConnections>");
    lines.push("    </component>");
    lines.push(
      componentOpen(
        "Microsoft-Windows-TerminalServices-RDP-WinStationExtensions",
      ),
    );
    lines.push("      <UserAuthentication>0</UserAuthentication>");
    lines.push("    </component>");
    lines.push(componentOpen("Networking-MPSSVC-Svc"));
    lines.push("      <FirewallGroups>");
    lines.push(
      '        <FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">',
    );
    lines.push("          <Active>true</Active>");
    lines.push("          <Group>Remote Desktop</Group>");
    lines.push("          <Profile>all</Profile>");
    lines.push("        </FirewallGroup>");
    lines.push("      </FirewallGroups>");
    lines.push("    </component>");
  }

  lines.push("  </settings>");

  // ── oobeSystem pass ───────────────────────────────────────────
  lines.push('  <settings pass="oobeSystem">');
  lines.push(componentOpen("Microsoft-Windows-International-Core"));
  lines.push(`      <InputLocale>${e(r.locale)}</InputLocale>`);
  lines.push(`      <SystemLocale>${e(r.locale)}</SystemLocale>`);
  lines.push(`      <UILanguage>${e(r.locale)}</UILanguage>`);
  lines.push(`      <UserLocale>${e(r.locale)}</UserLocale>`);
  lines.push("    </component>");

  lines.push(componentOpen("Microsoft-Windows-Shell-Setup"));
  lines.push("      <OOBE>");
  lines.push("        <HideEULAPage>true</HideEULAPage>");
  lines.push("        <HideLocalAccountScreen>true</HideLocalAccountScreen>");
  lines.push("        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>");
  lines.push("        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>");
  lines.push(`        <ProtectYourPC>${r.protectYourPC}</ProtectYourPC>`);
  lines.push("      </OOBE>");
  lines.push("      <UserAccounts>");
  lines.push("        <LocalAccounts>");
  lines.push('          <LocalAccount wcm:action="add">');
  lines.push(`            <Name>${e(r.adminUsername)}</Name>`);
  lines.push("            <Group>Administrators</Group>");
  lines.push(`            <DisplayName>${e(r.adminUsername)}</DisplayName>`);
  lines.push("            <Password>");
  lines.push(`              <Value>${e(r.adminPassword)}</Value>`);
  lines.push("              <PlainText>true</PlainText>");
  lines.push("            </Password>");
  lines.push("          </LocalAccount>");
  lines.push("        </LocalAccounts>");
  lines.push("      </UserAccounts>");
  lines.push("      <AutoLogon>");
  lines.push(`        <Username>${e(r.adminUsername)}</Username>`);
  lines.push("        <Password>");
  lines.push(`          <Value>${e(r.adminPassword)}</Value>`);
  lines.push("          <PlainText>true</PlainText>");
  lines.push("        </Password>");
  lines.push("        <Enabled>true</Enabled>");
  lines.push(`        <LogonCount>${r.autoLogonCount}</LogonCount>`);
  lines.push("      </AutoLogon>");
  lines.push("      <FirstLogonCommands>");
  lines.push('        <SynchronousCommand wcm:action="add">');
  lines.push("          <Order>1</Order>");
  lines.push(`          <Description>${e(r.firstLogon.description)}</Description>`);
  lines.push(
    `          <CommandLine>${e(r.firstLogon.commandLine)}</CommandLine>`,
  );
  lines.push("          <RequiresUserInput>false</RequiresUserInput>");
  lines.push("        </SynchronousCommand>");
  lines.push("      </FirstLogonCommands>");
  lines.push("    </component>");
  lines.push("  </settings>");

  lines.push("</unattend>");

  return UTF8_BOM + lines.join("\n") + "\n";
}

/** Emit `<component …>` with the canonical attribute order. */
function componentOpen(name: string): string {
  return (
    `    <component name="${name}" ` +
    `processorArchitecture="amd64" ` +
    `publicKeyToken="31bf3856ad364e35" ` +
    `language="neutral" ` +
    `versionScope="nonSxS" ` +
    `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">`
  );
}

/**
 * Minimal XML entity encoding. Sufficient for text + attribute
 * values that may legitimately contain ASCII `<`, `>`, `&`, `"`,
 * `'`. Non-ASCII passes through verbatim — Windows Setup is
 * happy with UTF-8 (which is why we BOM-prefix).
 */
function encodeXmlEntity(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Parse (round-trip helper for tests) ───────────────────────────

/**
 * Parse an Autounattend.xml emitted by {@link composeAutounattendXml}
 * back into a (partial) {@link UnattendedConfig}. NOT a general XML
 * parser — it's a hand-rolled extractor that matches the rigid
 * shape this composer emits. Used by `unattended.test.ts` for
 * round-trip checks.
 *
 * If the input has been tampered with (different layout, missing
 * elements), the missing fields fall back to defaults / undefined.
 * Callers should not rely on this for security-sensitive parsing.
 */
export function parseAutounattendXml(xml: string): UnattendedConfig {
  // Strip BOM if present.
  let body = xml.startsWith(UTF8_BOM) ? xml.slice(UTF8_BOM.length) : xml;
  // Drop the XML declaration if present.
  body = body.replace(/^<\?xml[^?]+\?>\s*/, "");

  const computerName = decodeFirst(body, "ComputerName");
  const registeredOwner = decodeFirst(body, "RegisteredOwner");
  const registeredOrganization = decodeFirst(body, "RegisteredOrganization");
  const tzMs = decodeFirst(body, "TimeZone");
  const locale = decodeFirst(body, "InputLocale");
  // Extract first <Name> from LocalAccount block (admin username).
  const adminUsername = decodeFirst(body, "Name");
  // Extract first <Value> from LocalAccount block (admin password).
  // (Password also appears under AutoLogon; both should match.)
  const adminPassword = decodeFirst(body, "Value");

  const fDeny = decodeFirst(body, "fDenyTSConnections");
  const enableRDP = fDeny === "false";

  const protectMatch = decodeFirst(body, "ProtectYourPC");
  let protectYourPC: 1 | 3 | undefined;
  if (protectMatch === "1") protectYourPC = 1;
  else if (protectMatch === "3") protectYourPC = 3;

  const logonCountStr = decodeFirst(body, "LogonCount");
  const autoLogonCount =
    logonCountStr !== null && /^\d+$/.test(logonCountStr)
      ? parseInt(logonCountStr, 10)
      : undefined;

  const firstLogonDescription = decodeFirst(body, "Description");
  const firstLogonCommandLine = decodeFirst(body, "CommandLine");

  const out: UnattendedConfig = {
    computerName: computerName ?? "",
    adminUsername: adminUsername ?? "",
    adminPassword: adminPassword ?? "",
    locale: locale ?? undefined,
    timezone: tzMs ?? undefined,
    autoLogonCount,
    enableRDP,
    protectYourPC,
    registeredOwner: registeredOwner ?? undefined,
    registeredOrganization: registeredOrganization ?? undefined,
  };
  if (firstLogonDescription !== null && firstLogonCommandLine !== null) {
    out.firstLogonCommand = {
      description: firstLogonDescription,
      commandLine: firstLogonCommandLine,
    };
  }
  return out;
}

function decodeFirst(body: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = re.exec(body);
  if (!m) return null;
  return decodeXmlEntity(m[1]);
}

function decodeXmlEntity(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

// ── Internal helpers exposed for tests ────────────────────────────

/** @internal — exposed for unit-tests. */
export const __internals = {
  encodeXmlEntity,
  decodeXmlEntity,
  UTF8_BOM,
};
