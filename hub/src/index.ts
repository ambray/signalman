/**
 * Signalman Hub — Commercial registry and orchestration service.
 *
 * The Hub provides:
 * - Guest agent discovery and registration
 * - Scenario repository (search, download, share)
 * - Centralized test result aggregation
 * - Team management and API keys
 * - CI/CD webhook integration
 *
 * This is the commercial offering on top of the open-source core.
 * The open-source tools work standalone; the Hub adds multi-user
 * collaboration and centralized management.
 *
 * @module hub
 */

export interface HubConfig {
  /** Hub API base URL. */
  apiUrl: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Organization slug. */
  org?: string;
}

export interface RegisteredAgent {
  /** Unique agent ID assigned by the Hub. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** IP address or hostname. */
  address: string;
  /** gRPC port. */
  port: number;
  /** Last heartbeat timestamp. */
  lastSeen: Date;
  /** Agent capabilities. */
  capabilities: string[];
}

export interface ScenarioEntry {
  /** Unique scenario ID. */
  id: string;
  /** Scenario name. */
  name: string;
  /** Description. */
  description: string;
  /** Tags for search. */
  tags: string[];
  /** Author. */
  author: string;
  /** Download URL. */
  downloadUrl: string;
  /** Last updated. */
  updatedAt: Date;
}

/**
 * Hub client for interacting with the Signalman Hub API.
 *
 * Usage:
 * ```typescript
 * const hub = new HubClient({ apiUrl: "https://hub.signalman.dev", apiKey: "sk-..." });
 * const agents = await hub.listAgents();
 * ```
 */
export class HubClient {
  private config: HubConfig;

  constructor(config: HubConfig) {
    this.config = config;
  }

  /** Register a guest agent with the Hub. */
  async registerAgent(
    name: string,
    address: string,
    port: number,
    capabilities: string[],
  ): Promise<RegisteredAgent> {
    // TODO: Implement Hub API call
    return {
      id: crypto.randomUUID(),
      name,
      address,
      port,
      lastSeen: new Date(),
      capabilities,
    };
  }

  /** List all registered guest agents. */
  async listAgents(): Promise<RegisteredAgent[]> {
    // TODO: Implement Hub API call
    return [];
  }

  /** Search the scenario repository. */
  async searchScenarios(query: string, tags?: string[]): Promise<ScenarioEntry[]> {
    // TODO: Implement Hub API call
    void query;
    void tags;
    return [];
  }

  /** Upload test results to the Hub. */
  async uploadResults(
    scenarioId: string,
    results: Record<string, unknown>,
  ): Promise<string> {
    // TODO: Implement Hub API call
    void scenarioId;
    void results;
    return crypto.randomUUID();
  }

  /** Get the Hub API URL. */
  get apiUrl(): string {
    return this.config.apiUrl;
  }
}
