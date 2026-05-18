/**
 * v0.5 Win11 M2 — Unattended.xml composer unit tests (Story 1).
 *
 * Covers:
 *  - composeAutounattendXml: every M0 §5/§6 field, BOM presence,
 *    defaults, entity escaping (password with `<`, `>`, `&`, `"`,
 *    `'`), determinism, custom firstLogonCommand,
 *    autoLogonCount=N, enableRDP=false branch, protectYourPC=1
 *    branch.
 *  - parseAutounattendXml: round-trip with the composer.
 *  - toNetbiosComputerName: truncate, replace, strip, all-special
 *    rejection.
 *  - resolveTimeZoneForUnattended: IANA hit, MS pass-through, miss.
 *  - input validation: empty computerName, empty username, missing
 *    password, bad autoLogonCount, bad timezone.
 */

import { describe, it, expect } from "vitest";
import {
  composeAutounattendXml,
  composeWithMeta,
  parseAutounattendXml,
  __internals,
  type UnattendedConfig,
} from "../provisioning/unattended.js";
import {
  toNetbiosComputerName,
  NETBIOS_MAX_LENGTH,
} from "../provisioning/unattended-computer-name.js";
import {
  resolveTimeZoneForUnattended,
  IANA_TO_MS_TIMEZONE,
  MS_TIMEZONE_NAMES,
} from "../provisioning/unattended-timezone.js";

const baseCfg = (): UnattendedConfig => ({
  computerName: "demo-vm",
  adminUsername: "signalman",
  adminPassword: "P@ssword123",
});

// ── composeAutounattendXml ────────────────────────────────────────

describe("composeAutounattendXml", () => {
  it("emits a BOM + xml declaration as the first bytes", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml.startsWith(__internals.UTF8_BOM)).toBe(true);
    expect(xml.slice(1).startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(
      true,
    );
  });

  it("emits a top-level <unattend> element with the canonical xmlns", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml).toContain(
      '<unattend xmlns="urn:schemas-microsoft-com:unattend">',
    );
    expect(xml.trimEnd().endsWith("</unattend>")).toBe(true);
  });

  it("emits specialize then oobeSystem passes in that order", () => {
    const xml = composeAutounattendXml(baseCfg());
    const specializeIdx = xml.indexOf('<settings pass="specialize">');
    const oobeIdx = xml.indexOf('<settings pass="oobeSystem">');
    expect(specializeIdx).toBeGreaterThan(0);
    expect(oobeIdx).toBeGreaterThan(specializeIdx);
  });

  it("emits every locked M0 §5 OOBE field", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml).toContain("<HideEULAPage>true</HideEULAPage>");
    expect(xml).toContain("<HideLocalAccountScreen>true</HideLocalAccountScreen>");
    expect(xml).toContain("<HideOnlineAccountScreens>true</HideOnlineAccountScreens>");
    expect(xml).toContain("<HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>");
    expect(xml).toContain("<ProtectYourPC>3</ProtectYourPC>");
    expect(xml).toContain("<Enabled>true</Enabled>");
    expect(xml).toContain("<LogonCount>3</LogonCount>");
  });

  it("emits every locked M0 §6 specialize field", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml).toContain("<ComputerName>demo-vm</ComputerName>");
    expect(xml).toContain("<TimeZone>UTC</TimeZone>");
    expect(xml).toContain("<RegisteredOwner>signalman</RegisteredOwner>");
    expect(xml).toContain(
      "<RegisteredOrganization>signalman</RegisteredOrganization>",
    );
  });

  it("enables RDP by default (Q4 lock)", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml).toContain("<fDenyTSConnections>false</fDenyTSConnections>");
    expect(xml).toContain("<UserAuthentication>0</UserAuthentication>");
    expect(xml).toContain('<FirewallGroup wcm:action="add" wcm:keyValue="RemoteDesktop">');
  });

  it("omits RDP / firewall blocks when enableRDP=false", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      enableRDP: false,
    });
    expect(xml).not.toContain("fDenyTSConnections");
    expect(xml).not.toContain("UserAuthentication");
    expect(xml).not.toContain("FirewallGroup");
  });

  it("writes the locked Q5 sentinel-file FirstLogonCommand by default", () => {
    const xml = composeAutounattendXml(baseCfg());
    expect(xml).toContain("<Description>signalman: signal readiness</Description>");
    expect(xml).toContain(
      "<CommandLine>cmd.exe /c &quot;echo ready &gt; C:\\signalman-ready.txt&quot;</CommandLine>",
    );
  });

  it("honours an operator-supplied firstLogonCommand override", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      firstLogonCommand: {
        description: "custom",
        commandLine: "cmd.exe /c ver",
      },
    });
    expect(xml).toContain("<Description>custom</Description>");
    expect(xml).toContain("<CommandLine>cmd.exe /c ver</CommandLine>");
  });

  it("entity-escapes the admin password's XML-special characters", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      adminPassword: `<>&"'`,
    });
    expect(xml).toContain("&lt;&gt;&amp;&quot;&apos;");
    // Should NOT contain a raw `<` or `>` adjacent to the password chars.
    expect(xml).not.toMatch(/<Value><<\/Value>/);
  });

  it("preserves entity-escaping for the username too", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      adminUsername: "a&b",
    });
    expect(xml).toContain("<Name>a&amp;b</Name>");
  });

  it("respects an operator-supplied autoLogonCount", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      autoLogonCount: 7,
    });
    expect(xml).toContain("<LogonCount>7</LogonCount>");
  });

  it("respects an operator-supplied protectYourPC=1", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      protectYourPC: 1,
    });
    expect(xml).toContain("<ProtectYourPC>1</ProtectYourPC>");
  });

  it("respects locale override", () => {
    const xml = composeAutounattendXml({ ...baseCfg(), locale: "de-DE" });
    expect(xml).toContain("<InputLocale>de-DE</InputLocale>");
    expect(xml).toContain("<SystemLocale>de-DE</SystemLocale>");
    expect(xml).toContain("<UILanguage>de-DE</UILanguage>");
    expect(xml).toContain("<UserLocale>de-DE</UserLocale>");
  });

  it("respects timezone override (IANA)", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      timezone: "America/Los_Angeles",
    });
    expect(xml).toContain("<TimeZone>Pacific Standard Time</TimeZone>");
  });

  it("respects timezone override (MS display name pass-through)", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      timezone: "Eastern Standard Time",
    });
    expect(xml).toContain("<TimeZone>Eastern Standard Time</TimeZone>");
  });

  it("respects registeredOwner / registeredOrganization overrides", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      registeredOwner: "acme",
      registeredOrganization: "acme corp",
    });
    expect(xml).toContain("<RegisteredOwner>acme</RegisteredOwner>");
    expect(xml).toContain("<RegisteredOrganization>acme corp</RegisteredOrganization>");
  });

  it("transliterates ComputerName via NetBIOS rules", () => {
    const xml = composeAutounattendXml({
      ...baseCfg(),
      computerName: "very.long.name.that.exceeds.netbios.length",
    });
    // Must be <=15 chars and only [A-Za-z0-9-].
    const m = /<ComputerName>([^<]+)<\/ComputerName>/.exec(xml);
    expect(m).not.toBeNull();
    if (!m) throw new Error("never");
    expect(m[1].length).toBeLessThanOrEqual(NETBIOS_MAX_LENGTH);
    expect(m[1]).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("is deterministic — same input -> same bytes", () => {
    const a = composeAutounattendXml(baseCfg());
    const b = composeAutounattendXml(baseCfg());
    expect(a).toBe(b);
  });

  it("rejects invalid cfg shapes", () => {
    expect(() => composeAutounattendXml(null as unknown as UnattendedConfig)).toThrow(
      TypeError,
    );
    expect(() =>
      composeAutounattendXml({ ...baseCfg(), computerName: "" }),
    ).toThrow(/non-empty string/);
    expect(() =>
      composeAutounattendXml({ ...baseCfg(), adminUsername: "" }),
    ).toThrow(/non-empty string/);
    expect(() =>
      composeAutounattendXml({
        ...baseCfg(),
        adminPassword: 42 as unknown as string,
      }),
    ).toThrow(/adminPassword must be a string/);
    expect(() =>
      composeAutounattendXml({ ...baseCfg(), autoLogonCount: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      composeAutounattendXml({ ...baseCfg(), autoLogonCount: 2.5 }),
    ).toThrow(/positive integer/);
  });
});

// ── composeWithMeta ───────────────────────────────────────────────

describe("composeWithMeta", () => {
  it("returns metadata describing the rewrite", () => {
    const result = composeWithMeta({
      ...baseCfg(),
      computerName: "very.long.name.that.is.too.long",
      timezone: "America/Los_Angeles",
      locale: "en-GB",
    });
    expect(result.meta.computerName.rewritten).toBe(true);
    expect(result.meta.computerName.source).toBe(
      "very.long.name.that.is.too.long",
    );
    expect(result.meta.computerName.result.length).toBeLessThanOrEqual(
      NETBIOS_MAX_LENGTH,
    );
    expect(result.meta.timezone.source).toBe("America/Los_Angeles");
    expect(result.meta.timezone.resolved).toBe("Pacific Standard Time");
    expect(result.meta.locale).toBe("en-GB");
  });

  it("reports rewritten=false when source matches result", () => {
    const result = composeWithMeta(baseCfg());
    expect(result.meta.computerName.rewritten).toBe(false);
    expect(result.meta.computerName.source).toBe("demo-vm");
    expect(result.meta.computerName.result).toBe("demo-vm");
  });
});

// ── parseAutounattendXml round-trip ───────────────────────────────

describe("parseAutounattendXml round-trip", () => {
  it("round-trips a default config", () => {
    const cfg = baseCfg();
    const xml = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml);
    expect(parsed.computerName).toBe("demo-vm");
    expect(parsed.adminUsername).toBe("signalman");
    expect(parsed.adminPassword).toBe("P@ssword123");
    expect(parsed.locale).toBe("en-US");
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.autoLogonCount).toBe(3);
    expect(parsed.enableRDP).toBe(true);
    expect(parsed.protectYourPC).toBe(3);
    expect(parsed.registeredOwner).toBe("signalman");
    expect(parsed.registeredOrganization).toBe("signalman");
  });

  it("round-trips entity-encoded passwords", () => {
    const cfg = { ...baseCfg(), adminPassword: `<>&"'` };
    const xml = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml);
    expect(parsed.adminPassword).toBe(`<>&"'`);
  });

  it("round-trips firstLogonCommand", () => {
    const cfg: UnattendedConfig = {
      ...baseCfg(),
      firstLogonCommand: {
        description: "custom",
        commandLine: "cmd.exe /c ver",
      },
    };
    const xml = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml);
    expect(parsed.firstLogonCommand?.description).toBe("custom");
    expect(parsed.firstLogonCommand?.commandLine).toBe("cmd.exe /c ver");
  });

  it("round-trips protectYourPC=1", () => {
    const cfg = { ...baseCfg(), protectYourPC: 1 as const };
    const xml = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml);
    expect(parsed.protectYourPC).toBe(1);
  });

  it("recognises enableRDP=false (no fDenyTSConnections element)", () => {
    const cfg = { ...baseCfg(), enableRDP: false };
    const xml = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml);
    expect(parsed.enableRDP).toBe(false);
  });

  it("strips the UTF-8 BOM before parsing", () => {
    const cfg = baseCfg();
    const xml = composeAutounattendXml(cfg);
    expect(xml.startsWith(__internals.UTF8_BOM)).toBe(true);
    // parser should not depend on the BOM
    const parsed = parseAutounattendXml(xml);
    expect(parsed.computerName).toBe("demo-vm");
    // also works without BOM
    const parsed2 = parseAutounattendXml(xml.slice(__internals.UTF8_BOM.length));
    expect(parsed2.computerName).toBe("demo-vm");
  });

  it("recompose(parse(compose(x))) is byte-identical", () => {
    const cfg = baseCfg();
    const xml1 = composeAutounattendXml(cfg);
    const parsed = parseAutounattendXml(xml1);
    const xml2 = composeAutounattendXml(parsed);
    expect(xml2).toBe(xml1);
  });

  it("returns empty / undefined fields when XML is missing tags", () => {
    const minimal = "<unattend></unattend>";
    const parsed = parseAutounattendXml(minimal);
    expect(parsed.computerName).toBe("");
    expect(parsed.adminUsername).toBe("");
    expect(parsed.adminPassword).toBe("");
    expect(parsed.autoLogonCount).toBeUndefined();
    expect(parsed.protectYourPC).toBeUndefined();
    expect(parsed.firstLogonCommand).toBeUndefined();
  });

  it("treats non-numeric LogonCount as undefined", () => {
    const xml = composeAutounattendXml(baseCfg()).replace(
      "<LogonCount>3</LogonCount>",
      "<LogonCount>abc</LogonCount>",
    );
    const parsed = parseAutounattendXml(xml);
    expect(parsed.autoLogonCount).toBeUndefined();
  });
});

// ── toNetbiosComputerName ─────────────────────────────────────────

describe("toNetbiosComputerName", () => {
  it("leaves a valid short name unchanged", () => {
    const r = toNetbiosComputerName("demo-vm");
    expect(r.result).toBe("demo-vm");
    expect(r.rewritten).toBe(false);
  });

  it("replaces dots, underscores, and unicode with '-'", () => {
    const r = toNetbiosComputerName("demo.vm_01");
    expect(r.result).toBe("demo-vm-01");
    expect(r.rewritten).toBe(true);
  });

  it("collapses consecutive non-alphanumeric runs into one '-'", () => {
    const r = toNetbiosComputerName("a...b___c");
    expect(r.result).toBe("a-b-c");
  });

  it("truncates to 15 characters", () => {
    const r = toNetbiosComputerName("abcdefghijklmnopqrstuvwxyz");
    expect(r.result.length).toBeLessThanOrEqual(NETBIOS_MAX_LENGTH);
    expect(r.result).toBe("abcdefghijklmno");
  });

  it("strips leading and trailing '-'", () => {
    const r = toNetbiosComputerName("---abc---");
    expect(r.result).toBe("abc");
  });

  it("strips a trailing '-' produced by truncation", () => {
    const r = toNetbiosComputerName("aaaaaaaaaaaaaa-bbbbb");
    // 14 a's + '-' would land on position 15 (the '-'), then strip.
    expect(r.result.endsWith("-")).toBe(false);
    expect(r.result.length).toBeLessThanOrEqual(NETBIOS_MAX_LENGTH);
  });

  it("throws when source has no alphanumerics", () => {
    expect(() => toNetbiosComputerName("...")).toThrow(/at least one/);
    expect(() => toNetbiosComputerName("")).toThrow(/at least one/);
  });

  it("rejects non-string input via TypeError", () => {
    expect(() => toNetbiosComputerName(42 as unknown as string)).toThrow(
      TypeError,
    );
  });

  it("preserves source verbatim in the result struct", () => {
    const r = toNetbiosComputerName("foo.bar");
    expect(r.source).toBe("foo.bar");
  });
});

// ── resolveTimeZoneForUnattended ──────────────────────────────────

describe("resolveTimeZoneForUnattended", () => {
  it("maps a known IANA name to the MS display form", () => {
    expect(resolveTimeZoneForUnattended("America/Los_Angeles")).toBe(
      "Pacific Standard Time",
    );
    expect(resolveTimeZoneForUnattended("Europe/Berlin")).toBe(
      "W. Europe Standard Time",
    );
  });

  it("passes through a known MS display name", () => {
    expect(resolveTimeZoneForUnattended("UTC")).toBe("UTC");
    expect(resolveTimeZoneForUnattended("Tokyo Standard Time")).toBe(
      "Tokyo Standard Time",
    );
  });

  it("supports the Etc/UTC and Etc/GMT alias", () => {
    expect(resolveTimeZoneForUnattended("Etc/UTC")).toBe("UTC");
    expect(resolveTimeZoneForUnattended("Etc/GMT")).toBe("UTC");
  });

  it("throws on an unmapped IANA name with a helpful message", () => {
    expect(() => resolveTimeZoneForUnattended("Mars/Olympus_Mons")).toThrow(
      /Unsupported timezone/,
    );
    expect(() => resolveTimeZoneForUnattended("Mars/Olympus_Mons")).toThrow(
      /America\/Los_Angeles/,
    );
  });

  it("throws on empty input", () => {
    expect(() => resolveTimeZoneForUnattended("")).toThrow(
      /non-empty string/,
    );
  });

  it("throws on non-string input", () => {
    expect(() =>
      resolveTimeZoneForUnattended(null as unknown as string),
    ).toThrow(/non-empty string/);
  });

  it("covers at least 30 IANA aliases", () => {
    expect(Object.keys(IANA_TO_MS_TIMEZONE).length).toBeGreaterThanOrEqual(30);
  });

  it("MS_TIMEZONE_NAMES is the deduped set of table values", () => {
    const expected = new Set(Object.values(IANA_TO_MS_TIMEZONE));
    expect(MS_TIMEZONE_NAMES.size).toBe(expected.size);
    for (const v of expected) expect(MS_TIMEZONE_NAMES.has(v)).toBe(true);
  });
});

// ── __internals ───────────────────────────────────────────────────

describe("__internals", () => {
  it("encodeXmlEntity escapes every XML-special character", () => {
    expect(__internals.encodeXmlEntity(`<>&"'`)).toBe(
      "&lt;&gt;&amp;&quot;&apos;",
    );
  });

  it("decodeXmlEntity is the inverse of encodeXmlEntity", () => {
    const original = `tricky <>&"' value`;
    expect(__internals.decodeXmlEntity(__internals.encodeXmlEntity(original))).toBe(
      original,
    );
  });
});
