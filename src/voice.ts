import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, Events } from "@fluxerjs/core";
import {
  LiveKitRtcConnection,
  getVoiceManager,
  type LiveKitAudioFrame,
  type LiveKitReceiveSubscription,
} from "@fluxerjs/voice";
import {
  buildAgentMediaPayload,
  createReplyPrefixOptions,
  formatErrorMessage,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { resolveFluxerAccount } from "./accounts.js";
import { getFluxerRuntime } from "./runtime.js";

type VoiceClientState = {
  client: Client;
  connectedAt: number;
};

type ParticipantAudioState = {
  subscription: LiveKitReceiveSubscription;
  sampleRate: number;
  channels: number;
  chunks: Int16Array[];
  totalSamples: number;
  processing: boolean;
};

type VoiceResponderSession = {
  key: string;
  accountId: string;
  guildId: string;
  channelId: string;
  connection: LiveKitRtcConnection;
  participants: Map<string, ParticipantAudioState>;
  queue: Promise<void>;
  onAudioFrame: (frame: LiveKitAudioFrame) => void;
  onSpeakerStart: (payload: { participantId: string }) => void;
  onSpeakerStop: (payload: { participantId: string }) => void;
  onDisconnect: () => void;
};

const voiceClients = new Map<string, VoiceClientState>();
const voiceResponderSessions = new Map<string, VoiceResponderSession>();

const MIN_UTTERANCE_SAMPLES = 48_000 / 4; // ~250ms @48kHz mono
const MAX_BUFFER_SAMPLES = 48_000 * 20; // ~20s safety cap

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

function toSessionKey(accountId: string, guildId: string, channelId: string): string {
  return `${accountId}:${guildId}:${channelId}`;
}

function flattenInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodePcm16Wav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

function mapTtsFormatToExt(format?: string): string {
  const normalized = (format ?? "").toLowerCase();
  if (normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav") || normalized.includes("pcm")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("opus")) return "opus";
  return "bin";
}

function applyVoiceTtsOverrides(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const account = resolveFluxerAccount({ cfg, accountId });
  const voiceTts = account.config.voice?.tts;
  if (!voiceTts) return cfg;

  const next = structuredClone(cfg);
  const anyNext = next as any;
  anyNext.tts = anyNext.tts ?? {};

  if (voiceTts.provider) {
    anyNext.tts.provider = voiceTts.provider;
  }

  if (voiceTts.openai?.voice) {
    anyNext.tts.openai = anyNext.tts.openai ?? {};
    anyNext.tts.openai.voice = voiceTts.openai.voice;
  }

  return next;
}

async function buildAssistantReplyFromAudio(params: {
  accountId: string;
  channelId: string;
  guildId: string;
  userId: string;
  wavPath: string;
}): Promise<string> {
  const runtime = getFluxerRuntime();
  const cfg = runtime.config.loadConfig();

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "fluxer",
    accountId: params.accountId,
    peer: {
      kind: "channel",
      id: params.channelId,
    },
  });

  const timestamp = Date.now();
  const fromLabel = `Fluxer Voice (${params.userId})`;
  const body = runtime.channel.reply.formatInboundEnvelope({
    channel: "Fluxer",
    from: fromLabel,
    timestamp,
    body: `Voice message from ${params.userId} in channel ${params.channelId}`,
    chatType: "channel",
    sender: { name: params.userId, id: params.userId },
  });

  const mediaPayload = buildAgentMediaPayload([
    {
      path: params.wavPath,
      contentType: "audio/wav",
    },
  ]);

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: "Voice input attached as audio. Please listen/transcribe and respond conversationally.",
    RawBody: "",
    CommandBody: "",
    From: `fluxer:voice:${params.userId}`,
    To: `channel:${params.channelId}`,
    SessionKey: `${route.sessionKey}:voice:${params.channelId}`,
    ParentSessionKey: route.mainSessionKey,
    AccountId: route.accountId,
    ChatType: "channel",
    ConversationLabel: `Voice ${params.channelId}`,
    GroupSubject: params.channelId,
    GroupChannel: `#${params.channelId}`,
    SenderName: params.userId,
    SenderId: params.userId,
    Provider: "fluxer",
    Surface: "fluxer",
    MessageSid: `voice:${params.userId}:${timestamp}`,
    Timestamp: timestamp,
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "fluxer",
    OriginatingTo: `channel:${params.channelId}`,
    ...mediaPayload,
  });

  const chunks: string[] = [];
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "fluxer",
    accountId: route.accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } = runtime.channel.reply.createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      const text = (payload.text ?? "").trim();
      if (!text || text === "NO_REPLY") return;
      chunks.push(text);
    },
    onError: (_err) => {
      // best-effort collection; errors surfaced by dispatch below
    },
  });

  try {
    await runtime.channel.reply.dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onModelSelected,
      },
    });
  } finally {
    markDispatchIdle();
  }

  return chunks.join("\n").trim();
}

async function synthesizeAndPlayReply(params: {
  accountId: string;
  connection: LiveKitRtcConnection;
  text: string;
}): Promise<void> {
  const runtime = getFluxerRuntime();
  const cfg = runtime.config.loadConfig();
  const effectiveCfg = applyVoiceTtsOverrides(cfg, params.accountId);

  const tts = await runtime.tts.textToSpeechTelephony({
    text: params.text,
    cfg: effectiveCfg,
  });

  if (!tts.success || !tts.audioBuffer) {
    throw new Error(tts.error || "TTS synthesis failed");
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sourceExt = mapTtsFormatToExt(tts.outputFormat);
  const sourcePath = path.join(tmpdir(), `fluxer-voice-tts-${stamp}.${sourceExt}`);
  const webmPath = path.join(tmpdir(), `fluxer-voice-tts-${stamp}.webm`);

  await fs.writeFile(sourcePath, tts.audioBuffer);

  try {
    const result = await runtime.system.runCommandWithTimeout(
      [
        "ffmpeg",
        "-y",
        "-i",
        sourcePath,
        "-vn",
        "-c:a",
        "libopus",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "webm",
        webmPath,
      ],
      { timeoutMs: 30_000 },
    );

    if (result.code !== 0) {
      throw new Error(result.stderr || `ffmpeg failed with code ${result.code}`);
    }

    await params.connection.play(createReadStream(webmPath));
  } finally {
    await fs.unlink(sourcePath).catch(() => undefined);
    await fs.unlink(webmPath).catch(() => undefined);
  }
}

async function processSpeakerUtterance(params: {
  session: VoiceResponderSession;
  participantId: string;
}): Promise<void> {
  const state = params.session.participants.get(params.participantId);
  if (!state || state.processing) return;
  if (state.totalSamples < MIN_UTTERANCE_SAMPLES) {
    state.chunks = [];
    state.totalSamples = 0;
    return;
  }

  const sampleRate = state.sampleRate || 48_000;
  const channels = state.channels || 1;
  const chunks = state.chunks;
  state.chunks = [];
  state.totalSamples = 0;
  state.processing = true;

  const wavSamples = flattenInt16(chunks);
  const wavBuffer = encodePcm16Wav(wavSamples, sampleRate, channels);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = path.join(tmpdir(), `fluxer-voice-in-${params.participantId}-${stamp}.wav`);

  try {
    await fs.writeFile(wavPath, wavBuffer);

    const replyText = await buildAssistantReplyFromAudio({
      accountId: params.session.accountId,
      guildId: params.session.guildId,
      channelId: params.session.channelId,
      userId: params.participantId,
      wavPath,
    });

    if (!replyText) return;

    await synthesizeAndPlayReply({
      accountId: params.session.accountId,
      connection: params.session.connection,
      text: replyText,
    });
  } catch (error) {
    const runtime = getFluxerRuntime();
    const logger = runtime.logging.getChildLogger({ module: "fluxer.voice" });
    logger.error?.(`utterance processing failed: ${formatErrorMessage(error)}`);
  } finally {
    state.processing = false;
    await fs.unlink(wavPath).catch(() => undefined);
  }
}

function teardownResponderSession(key: string): void {
  const session = voiceResponderSessions.get(key);
  if (!session) return;

  for (const entry of session.participants.values()) {
    entry.subscription.stop();
  }
  session.participants.clear();

  session.connection.off("audioFrame", session.onAudioFrame);
  session.connection.off("speakerStart", session.onSpeakerStart);
  session.connection.off("speakerStop", session.onSpeakerStop);
  session.connection.off("disconnect", session.onDisconnect);

  voiceResponderSessions.delete(key);
}

function ensureResponderSession(params: {
  accountId: string;
  guildId: string;
  channelId: string;
  connection: LiveKitRtcConnection;
}): VoiceResponderSession {
  const key = toSessionKey(params.accountId, params.guildId, params.channelId);
  const existing = voiceResponderSessions.get(key);
  if (existing && existing.connection === params.connection) {
    return existing;
  }
  if (existing) {
    teardownResponderSession(key);
  }

  const session: VoiceResponderSession = {
    key,
    accountId: params.accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    connection: params.connection,
    participants: new Map(),
    queue: Promise.resolve(),
    onAudioFrame: (frame) => {
      const state = session.participants.get(frame.participantId);
      if (!state) return;
      state.sampleRate = frame.sampleRate;
      state.channels = frame.channels;
      state.totalSamples += frame.samples.length;
      state.chunks.push(frame.samples.slice());

      if (state.totalSamples > MAX_BUFFER_SAMPLES) {
        while (state.totalSamples > MAX_BUFFER_SAMPLES && state.chunks.length > 0) {
          const removed = state.chunks.shift();
          if (!removed) break;
          state.totalSamples -= removed.length;
        }
      }
    },
    onSpeakerStart: ({ participantId }) => {
      const state = session.participants.get(participantId);
      if (!state) return;
      state.chunks = [];
      state.totalSamples = 0;
    },
    onSpeakerStop: ({ participantId }) => {
      if (!session.participants.has(participantId)) return;
      session.queue = session.queue
        .then(() => processSpeakerUtterance({ session, participantId }))
        .catch(() => undefined);
    },
    onDisconnect: () => {
      teardownResponderSession(key);
    },
  };

  params.connection.on("audioFrame", session.onAudioFrame);
  params.connection.on("speakerStart", session.onSpeakerStart);
  params.connection.on("speakerStop", session.onSpeakerStop);
  params.connection.on("disconnect", session.onDisconnect);

  voiceResponderSessions.set(key, session);
  return session;
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

  const keysToTearDown: string[] = [];
  for (const [key, session] of voiceResponderSessions.entries()) {
    if (session.accountId === accountId && session.guildId === params.guildId) {
      keysToTearDown.push(key);
    }
  }
  for (const key of keysToTearDown) teardownResponderSession(key);

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

export async function voiceSubscribeFluxer(params: {
  guildId: string;
  channelId: string;
  userId: string;
  accountId?: string;
}): Promise<{
  ok: true;
  accountId: string;
  guildId: string;
  channelId: string;
  userId: string;
  activeSubscriptions: string[];
}> {
  const { accountId, client } = await ensureVoiceClient(params.accountId);
  const voiceManager = getVoiceManager(client as any);

  let connection = voiceManager.getConnection?.(params.channelId);
  if (!connection) {
    const anyClient = client as any;
    const channel = await anyClient.channels.fetch(params.channelId);
    if (!channel) {
      throw new Error(`Fluxer voice channel not found: ${params.channelId}`);
    }
    connection = await voiceManager.join(channel);
  }

  if (!(connection instanceof LiveKitRtcConnection)) {
    throw new Error("Fluxer voice subscribe requires a LiveKit voice connection");
  }

  const session = ensureResponderSession({
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    connection,
  });

  const existing = session.participants.get(params.userId);
  if (existing) {
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: Array.from(session.participants.keys()),
    };
  }

  const subscription = connection.subscribeParticipantAudio(params.userId, {
    autoResubscribe: true,
  });

  session.participants.set(params.userId, {
    subscription,
    sampleRate: 48_000,
    channels: 1,
    chunks: [],
    totalSamples: 0,
    processing: false,
  });

  return {
    ok: true,
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    activeSubscriptions: Array.from(session.participants.keys()),
  };
}

export async function voiceUnsubscribeFluxer(params: {
  guildId: string;
  channelId: string;
  userId: string;
  accountId?: string;
}): Promise<{
  ok: true;
  accountId: string;
  guildId: string;
  channelId: string;
  userId: string;
  activeSubscriptions: string[];
}> {
  const { accountId } = await ensureVoiceClient(params.accountId);
  const key = toSessionKey(accountId, params.guildId, params.channelId);
  const session = voiceResponderSessions.get(key);

  if (!session) {
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: [],
    };
  }

  const entry = session.participants.get(params.userId);
  if (entry) {
    entry.subscription.stop();
    session.participants.delete(params.userId);
  }

  if (session.participants.size === 0) {
    teardownResponderSession(key);
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: [],
    };
  }

  return {
    ok: true,
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    activeSubscriptions: Array.from(session.participants.keys()),
  };
}
