import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { FluxerAccountConfig } from "./types.js";

export type FluxerTokenSource = "env" | "config" | "none";
export type FluxerBaseUrlSource = "env" | "config" | "none";

export type ResolvedFluxerAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  apiToken?: string;
  baseUrl?: string;
  tokenSource: FluxerTokenSource;
  baseUrlSource: FluxerBaseUrlSource;
  config: FluxerAccountConfig;
};

function normalizeBaseUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.fluxer?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listFluxerAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultFluxerAccountId(cfg: OpenClawConfig): string {
  const ids = listFluxerAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): FluxerAccountConfig | undefined {
  const accounts = cfg.channels?.fluxer?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as FluxerAccountConfig | undefined;
}

function mergeFluxerAccountConfig(cfg: OpenClawConfig, accountId: string): FluxerAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.fluxer ?? {}) as FluxerAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveFluxerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFluxerAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.fluxer?.enabled !== false;
  const merged = mergeFluxerAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.FLUXER_API_TOKEN?.trim() : undefined;
  const envBaseUrl = allowEnv ? process.env.FLUXER_BASE_URL?.trim() : undefined;
  const configToken = merged.apiToken?.trim();
  const configBaseUrl = normalizeBaseUrl(merged.baseUrl);
  const apiToken = configToken || envToken;
  const baseUrl = normalizeBaseUrl(configBaseUrl || envBaseUrl);

  const tokenSource: FluxerTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const baseUrlSource: FluxerBaseUrlSource = configBaseUrl ? "config" : envBaseUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    apiToken,
    baseUrl,
    tokenSource,
    baseUrlSource,
    config: merged,
  };
}

export function listEnabledFluxerAccounts(cfg: OpenClawConfig): ResolvedFluxerAccount[] {
  return listFluxerAccountIds(cfg)
    .map((accountId) => resolveFluxerAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
