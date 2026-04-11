/**
 * ACME / Let's Encrypt certificate management (stub).
 *
 * For production Hub deployments, this module will handle automatic
 * certificate provisioning and renewal via the ACME protocol
 * (Let's Encrypt or other ACME-compatible CAs).
 *
 * Current status: Stub — self-signed certificates are used for
 * development and testing. See generate.sh / generate.ps1.
 *
 * Planned features:
 * - Automatic certificate issuance for Hub domains
 * - Certificate renewal before expiry (30-day window)
 * - DNS-01 challenge support (for wildcard certs)
 * - HTTP-01 challenge support (for standard certs)
 * - Certificate storage in platform secret managers (Azure Key Vault, AWS ACM)
 * - mTLS CA certificate distribution to guest agents
 *
 * @module certs/acme
 */

export interface AcmeConfig {
  /** ACME directory URL (default: Let's Encrypt production). */
  directoryUrl: string;
  /** Contact email for the ACME account. */
  email: string;
  /** Domain names to provision certificates for. */
  domains: string[];
  /** Challenge type: "http-01" or "dns-01". */
  challengeType: "http-01" | "dns-01";
  /** Path to store certificates locally. */
  certStorePath: string;
  /** Days before expiry to trigger renewal. */
  renewalWindowDays: number;
}

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

export interface CertificateInfo {
  /** Domain the certificate is issued for. */
  domain: string;
  /** PEM-encoded certificate chain. */
  certPem: string;
  /** PEM-encoded private key. */
  keyPem: string;
  /** Certificate expiry date. */
  expiresAt: Date;
  /** Whether this cert was auto-provisioned via ACME. */
  isAcme: boolean;
}

/**
 * ACME certificate manager.
 *
 * This is currently a stub that returns self-signed certificate info.
 * The real implementation will use an ACME client library.
 */
export class AcmeCertManager {
  private config: AcmeConfig;

  constructor(config: AcmeConfig) {
    this.config = config;
  }

  /** Check if certificates exist and are valid. */
  async checkCertificates(): Promise<{ valid: boolean; expiresInDays?: number }> {
    // TODO: Implement certificate checking
    console.warn("[ACME] Certificate checking not yet implemented — using self-signed certs");
    return { valid: false };
  }

  /** Provision new certificates via ACME. */
  async provisionCertificates(): Promise<CertificateInfo[]> {
    // TODO: Implement ACME certificate provisioning
    throw new Error(
      "[ACME] Certificate provisioning not yet implemented. " +
      "Use certs/generate.sh for self-signed certificates."
    );
  }

  /** Renew certificates that are within the renewal window. */
  async renewIfNeeded(): Promise<CertificateInfo[]> {
    // TODO: Implement certificate renewal
    const status = await this.checkCertificates();
    if (status.valid && status.expiresInDays !== undefined &&
        status.expiresInDays > this.config.renewalWindowDays) {
      return []; // No renewal needed
    }
    return this.provisionCertificates();
  }

  /** Get the configured ACME directory URL. */
  get directoryUrl(): string {
    return this.config.directoryUrl;
  }
}
