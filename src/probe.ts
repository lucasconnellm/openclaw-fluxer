import type { FluxerClient } from "./client.js";
import { createFluxerClient } from "./client.js";

export type FluxerProbe = {
  ok: boolean;
  error?: string | null;
  checkedAt: number;
  latencyMs?: number;
  mode: "live" | "stub";
  botId?: string;
  botName?: string;
};

export async function probeFluxer(
  baseUrl: string | undefined,
  apiToken: string | undefined,
  timeoutMs = 2500,
  opts: {
    accountId?: string;
    authScheme?: string;
    client?: FluxerClient;
  } = {},
): Promise<FluxerProbe> {
  const normalizedBaseUrl = baseUrl?.trim();
  const normalizedToken = apiToken?.trim();

  if (!normalizedBaseUrl || !normalizedToken) {
    return {
      ok: false,
      error: "apiToken or baseUrl missing",
      checkedAt: Date.now(),
      mode: "stub",
    };
  }

  const startedAt = Date.now();
  const client =
    opts.client ??
    createFluxerClient({
      accountId: opts.accountId ?? "default",
      baseUrl: normalizedBaseUrl,
      apiToken: normalizedToken,
      authScheme: opts.authScheme,
    });

  try {
    const result = await client.probe({ timeoutMs });
    return {
      ok: result.ok,
      error: result.error ?? null,
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs ?? Date.now() - startedAt,
      mode: result.mode,
      botId: result.botId,
      botName: result.botName,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      mode: "live",
    };
  }
}
