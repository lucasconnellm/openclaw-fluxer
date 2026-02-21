import { Client, Events } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { resolveFluxerAccount } from "./accounts.js";
import { getFluxerRuntime } from "./runtime.js";

type VoiceClientState = {
  client: Client;
  connectedAt: number;
};

const voiceClients = new Map<string, VoiceClientState>();

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function resolveRestApiAndVersion(baseUrl: string): { api: string; version: string } {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const rawPath = parsed.pathname.replace(/\/+$/, "");
  const m = rawPath.match(/^(.*)\/v(\d+)$/i);
  if (m) {
    const apiPath = m[1] || "";
    return { api: `${parsed.origin}${apiPath}`, version: m[2] };
  }
  return { api: `${parsed.origin}${rawPath}`, version: "1" };
}

async function waitForClientReady(client: Client, timeoutMs = 15_000): Promise<void> {
  if ((client as any).isReady?.()) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Fluxer voice client did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const cleanup = () => {
      clearTimeout(timer);
      (client as any).off?.(Events.Ready, onReady);
      (client as any).off?.(Events.Error as any, onError);
    };

    client.once(Events.Ready as any, onReady);
    client.once(Events.Error as any, onError);
  });
}

async function ensureVoiceClient(accountId?: string): Promise<{ accountId: string; client: Client }> {
  const runtime = getFluxerRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveFluxerAccount({ cfg, accountId });
  const apiToken = account.apiToken?.trim();
  const baseUrl = account.baseUrl?.trim();

  if (!apiToken || !baseUrl) {
    throw new Error(`Fluxer voice not configured for account \"${account.accountId}\"`);
  }

  const existing = voiceClients.get(account.accountId);
  if (existing) {
    await waitForClientReady(existing.client).catch(() => undefined);
    return { accountId: account.accountId, client: existing.client };
  }

  const { api, version } = resolveRestApiAndVersion(baseUrl);
  const client = new Client({
    intents: 0,
    suppressIntentWarning: true,
    rest: {
      api,
      version,
      authPrefix: "Bot",
    },
  });

  client.rest.setToken(apiToken);
  await client.login(apiToken);
  await waitForClientReady(client);
  voiceClients.set(account.accountId, { client, connectedAt: Date.now() });

  return { accountId: account.accountId, client };
}

export async function voiceJoinFluxer(params: {
  guildId: string;
  channelId: string;
  accountId?: string;
}): Promise<{ ok: true; accountId: string; guildId: string; channelId: string }> {
  const { accountId, client } = await ensureVoiceClient(params.accountId);
  const anyClient = client as any;
  const channel = await anyClient.channels.fetch(params.channelId);
  if (!channel) {
    throw new Error(`Fluxer voice channel not found: ${params.channelId}`);
  }

  const voiceManager = getVoiceManager(client as any);
  await voiceManager.join(channel);

  return { ok: true, accountId, guildId: params.guildId, channelId: params.channelId };
}

export async function voiceLeaveFluxer(params: {
  guildId: string;
  accountId?: string;
}): Promise<{ ok: true; accountId: string; guildId: string }> {
  const { accountId, client } = await ensureVoiceClient(params.accountId);
  const voiceManager = getVoiceManager(client as any);
  voiceManager.leave(params.guildId);
  return { ok: true, accountId, guildId: params.guildId };
}

export async function voiceStatusFluxer(params: {
  guildId: string;
  userId: string;
  accountId?: string;
}): Promise<{
  accountId: string;
  guildId: string;
  userId: string;
  voiceChannelId?: string;
  voiceChannelName?: string;
  botConnected: boolean;
}> {
  const { accountId, client } = await ensureVoiceClient(params.accountId);
  const anyClient = client as any;

  let voiceChannelId: string | undefined;
  let voiceChannelName: string | undefined;

  try {
    const guild = await anyClient.guilds.fetch(params.guildId);
    const member = await guild?.members?.fetch?.(params.userId);
    const channelId = member?.voice?.channelId;
    if (channelId) {
      voiceChannelId = String(channelId);
      const voiceChannel = await anyClient.channels.fetch(channelId);
      voiceChannelName = voiceChannel?.name ? String(voiceChannel.name) : undefined;
    }
  } catch {
    // best-effort status only
  }

  const voiceManager = getVoiceManager(client as any);
  const botConnected = Boolean(voiceManager.getConnection?.(params.guildId));

  return {
    accountId,
    guildId: params.guildId,
    userId: params.userId,
    voiceChannelId,
    voiceChannelName,
    botConnected,
  };
}
