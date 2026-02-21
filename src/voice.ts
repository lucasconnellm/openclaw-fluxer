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
  requestedUserId: string;
  sourceParticipantId: string;
  sampleRate: number;
  channels: number;
  chunks: Int16Array[];
  totalSamples: number;
  processing: boolean;
  frameCount: number;
  collecting: boolean;
  utteranceStartedAtMs?: number;
  lastUtteranceDurationMs?: number;
};

type VoiceResponderSession = {
  key: string;
  accountId: string;
  guildId: string;
  channelId: string;
  connection: LiveKitRtcConnection;
  participants: Map<string, ParticipantAudioState>;
  aliases: Map<string, string>;
  unsubscribedFrameCounts: Map<string, number>;
  queue: Promise<void>;
  onAudioFrame: (frame: LiveKitAudioFrame) => void;
  onSpeakerStart: (payload: { participantId: string }) => void;
  onSpeakerStop: (payload: { participantId: string }) => void;
  onDisconnect: () => void;
};

const voiceClients = new Map<string, VoiceClientState>();
const voiceResponderSessions = new Map<string, VoiceResponderSession>();

const DEFAULT_MIN_UTTERANCE_MS = 250;
const DEFAULT_MIN_UTTERANCE_FALLBACK_MS = 2_500;
const MAX_BUFFER_SAMPLES = 48_000 * 20; // ~20s safety cap
const VOICE_TRACE_ENABLED = process.env.FLUXER_VOICE_TRACE !== "0";

function getVoiceLogger() {
  const runtime = getFluxerRuntime();
  return runtime.logging.getChildLogger({ module: "fluxer.voice" });
}

function voiceTrace(message: string, meta?: Record<string, unknown>): void {
  if (!VOICE_TRACE_ENABLED) return;
  getVoiceLogger().info?.(message, meta);
}

function voiceWarn(message: string, meta?: Record<string, unknown>): void {
  getVoiceLogger().warn?.(message, meta);
}

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
  if ((client as any).isReady?.()) {
    voiceTrace("voice client already ready");
    return;
  }

  voiceTrace("waiting for voice client ready", { timeoutMs });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      voiceWarn("voice client ready wait timed out", { timeoutMs });
      reject(new Error(`Fluxer voice client did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      voiceTrace("voice client ready event received");
      resolve();
    };

    const onError = (err: unknown) => {
      cleanup();
      voiceWarn("voice client ready wait errored", {
        error: err instanceof Error ? err.message : String(err),
      });
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

function canonicalId(value: string): string {
  return value.trim().toLowerCase().replace(/^(user|fluxer|participant):/, "");
}

function extractNumericTokens(value: string): string[] {
  return (value.match(/\d{5,}/g) ?? []).filter(Boolean);
}

function resolveLiveKitParticipantId(params: {
  requestedUserId: string;
  remoteParticipantIds: string[];
}): string {
  const requested = params.requestedUserId.trim();
  const requestedCanonical = canonicalId(requested);
  const requestedTokens = new Set(extractNumericTokens(requested));

  const exact = params.remoteParticipantIds.find((id) => id === requested);
  if (exact) return exact;

  const canonical = params.remoteParticipantIds.find((id) => canonicalId(id) === requestedCanonical);
  if (canonical) return canonical;

  const contains = params.remoteParticipantIds.find(
    (id) => id.includes(requested) || requested.includes(id),
  );
  if (contains) return contains;

  const tokenMatch = params.remoteParticipantIds.find((id) => {
    const tokens = extractNumericTokens(id);
    return tokens.some((token) => requestedTokens.has(token));
  });
  if (tokenMatch) return tokenMatch;

  return requested;
}

function resolveParticipantStateForIncoming(
  session: VoiceResponderSession,
  incomingParticipantId: string,
): ParticipantAudioState | undefined {
  const direct = session.participants.get(incomingParticipantId);
  if (direct) return direct;

  const incomingCanonical = canonicalId(incomingParticipantId);
  const incomingTokens = new Set(extractNumericTokens(incomingParticipantId));

  for (const [key, state] of session.participants.entries()) {
    const keyCanonical = canonicalId(key);
    const requestedCanonical = canonicalId(state.requestedUserId);

    let matched =
      incomingCanonical === keyCanonical ||
      incomingCanonical === requestedCanonical ||
      incomingParticipantId.includes(state.requestedUserId) ||
      state.requestedUserId.includes(incomingParticipantId);

    if (!matched && incomingTokens.size > 0) {
      const keyTokens = extractNumericTokens(key);
      const requestedTokens = extractNumericTokens(state.requestedUserId);
      matched =
        keyTokens.some((token) => incomingTokens.has(token)) ||
        requestedTokens.some((token) => incomingTokens.has(token));
    }

    if (!matched) continue;

    if (key !== incomingParticipantId) {
      session.participants.delete(key);
      state.sourceParticipantId = incomingParticipantId;
      session.participants.set(incomingParticipantId, state);
      session.aliases.set(state.requestedUserId, incomingParticipantId);
      voiceTrace("remapped participant identity", {
        sessionKey: session.key,
        requestedUserId: state.requestedUserId,
        oldParticipantId: key,
        newParticipantId: incomingParticipantId,
      });
    }

    return state;
  }

  return undefined;
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
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("pcm") || normalized.includes("s16")) return "pcm";
  return "bin";
}

function isTelephonyPcmOutput(format?: string): boolean {
  const normalized = (format ?? "").toLowerCase();
  if (!normalized) return true; // textToSpeechTelephony defaults to PCM
  return (
    normalized.includes("pcm") ||
    normalized.includes("s16") ||
    normalized.includes("raw") ||
    normalized === "linear16"
  );
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

function resolveVoiceUtteranceThresholds(accountId: string): {
  minUtteranceMs: number;
  minUtteranceFallbackMs: number;
} {
  const runtime = getFluxerRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveFluxerAccount({ cfg, accountId });
  const minUtteranceMsRaw = account.config.voice?.minUtteranceMs;
  const fallbackMsRaw = account.config.voice?.minUtteranceFallbackMs;

  const minUtteranceMs = Math.max(
    0,
    Number.isFinite(minUtteranceMsRaw as number)
      ? Number(minUtteranceMsRaw)
      : DEFAULT_MIN_UTTERANCE_MS,
  );
  const minUtteranceFallbackMs = Math.max(
    minUtteranceMs,
    Number.isFinite(fallbackMsRaw as number)
      ? Number(fallbackMsRaw)
      : DEFAULT_MIN_UTTERANCE_FALLBACK_MS,
  );

  return {
    minUtteranceMs,
    minUtteranceFallbackMs,
  };
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

  voiceTrace("building assistant reply from audio", {
    accountId: params.accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    wavPath: params.wavPath,
  });

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

  const reply = chunks.join("\n").trim();
  voiceTrace("assistant reply built from audio", {
    accountId: params.accountId,
    channelId: params.channelId,
    userId: params.userId,
    textLength: reply.length,
    chunkCount: chunks.length,
  });
  return reply;
}

async function synthesizeAndPlayReply(params: {
  accountId: string;
  connection: LiveKitRtcConnection;
  text: string;
}): Promise<void> {
  const runtime = getFluxerRuntime();
  const cfg = runtime.config.loadConfig();
  const effectiveCfg = applyVoiceTtsOverrides(cfg, params.accountId);

  voiceTrace("starting TTS synthesis", {
    accountId: params.accountId,
    textLength: params.text.length,
  });

  const tts = await runtime.tts.textToSpeechTelephony({
    text: params.text,
    cfg: effectiveCfg,
  });

  if (!tts.success || !tts.audioBuffer) {
    voiceWarn("TTS synthesis failed", {
      accountId: params.accountId,
      error: tts.error || "unknown",
      provider: tts.provider,
    });
    throw new Error(tts.error || "TTS synthesis failed");
  }

  voiceTrace("TTS synthesis complete", {
    accountId: params.accountId,
    provider: tts.provider,
    outputFormat: tts.outputFormat,
    latencyMs: tts.latencyMs,
    bytes: tts.audioBuffer.byteLength,
  });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pcmInput = isTelephonyPcmOutput(tts.outputFormat);
  const pcmSampleRate = tts.sampleRate && Number.isFinite(tts.sampleRate) ? tts.sampleRate : 24_000;
  const sourceExt = pcmInput ? "s16le" : mapTtsFormatToExt(tts.outputFormat);
  const sourcePath = path.join(tmpdir(), `fluxer-voice-tts-${stamp}.${sourceExt}`);
  const webmPath = path.join(tmpdir(), `fluxer-voice-tts-${stamp}.webm`);

  await fs.writeFile(sourcePath, tts.audioBuffer);

  try {
    voiceTrace("transcoding TTS audio to webm/opus", {
      accountId: params.accountId,
      sourcePath,
      webmPath,
      pcmInput,
      pcmSampleRate,
      outputFormat: tts.outputFormat,
    });

    const ffmpegArgs = ["ffmpeg", "-y"];
    if (pcmInput) {
      ffmpegArgs.push("-f", "s16le", "-ar", String(pcmSampleRate), "-ac", "1");
    }
    ffmpegArgs.push(
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
    );

    const result = await runtime.system.runCommandWithTimeout(ffmpegArgs, { timeoutMs: 30_000 });

    if (result.code !== 0) {
      voiceWarn("ffmpeg transcode failed", {
        accountId: params.accountId,
        code: result.code,
        stderr: result.stderr?.slice?.(0, 500) ?? result.stderr,
      });
      throw new Error(result.stderr || `ffmpeg failed with code ${result.code}`);
    }

    voiceTrace("ffmpeg transcode complete; starting voice playback", {
      accountId: params.accountId,
      channelId: params.connection.channel.id,
      guildId: params.connection.channel.guildId,
    });

    await params.connection.play(createReadStream(webmPath));

    voiceTrace("voice playback finished", {
      accountId: params.accountId,
      channelId: params.connection.channel.id,
      guildId: params.connection.channel.guildId,
    });
  } finally {
    await fs.unlink(sourcePath).catch(() => undefined);
    await fs.unlink(webmPath).catch(() => undefined);
    voiceTrace("cleaned up temporary TTS files", {
      accountId: params.accountId,
    });
  }
}

async function processSpeakerUtterance(params: {
  session: VoiceResponderSession;
  participantId: string;
}): Promise<void> {
  const state = params.session.participants.get(params.participantId);
  if (!state || state.processing) return;

  const requestedUserId = state.requestedUserId;
  const sourceParticipantId = state.sourceParticipantId;
  const sampleRate = state.sampleRate || 48_000;
  const { minUtteranceMs, minUtteranceFallbackMs } = resolveVoiceUtteranceThresholds(
    params.session.accountId,
  );
  const minSamples = Math.max(1, Math.floor((sampleRate * minUtteranceMs) / 1000));
  const utteranceDurationMs =
    state.lastUtteranceDurationMs ??
    (state.utteranceStartedAtMs ? Date.now() - state.utteranceStartedAtMs : 0);
  const meetsSampleGate = state.totalSamples >= minSamples;
  const meetsTimeFallback = utteranceDurationMs >= minUtteranceFallbackMs && state.totalSamples > 0;

  if (!meetsSampleGate && !meetsTimeFallback) {
    voiceTrace("dropping short utterance", {
      sessionKey: params.session.key,
      participantId: sourceParticipantId,
      requestedUserId,
      totalSamples: state.totalSamples,
      minSamples,
      utteranceDurationMs,
      minUtteranceMs,
      minUtteranceFallbackMs,
    });
    state.collecting = false;
    state.chunks = [];
    state.totalSamples = 0;
    state.lastUtteranceDurationMs = undefined;
    state.utteranceStartedAtMs = undefined;
    return;
  }

  voiceTrace("processing utterance", {
    sessionKey: params.session.key,
    participantId: sourceParticipantId,
    requestedUserId,
    totalSamples: state.totalSamples,
    frameCount: state.frameCount,
    utteranceDurationMs,
    minSamples,
    minUtteranceMs,
    minUtteranceFallbackMs,
    gate: meetsSampleGate ? "sample" : "time-fallback",
  });

  const channels = state.channels || 1;
  const chunks = state.chunks;
  state.chunks = [];
  state.totalSamples = 0;
  state.collecting = false;
  state.processing = true;
  state.lastUtteranceDurationMs = undefined;
  state.utteranceStartedAtMs = undefined;

  const wavSamples = flattenInt16(chunks);
  const wavBuffer = encodePcm16Wav(wavSamples, sampleRate, channels);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = path.join(tmpdir(), `fluxer-voice-in-${requestedUserId}-${stamp}.wav`);

  try {
    await fs.writeFile(wavPath, wavBuffer);
    voiceTrace("wrote utterance wav", {
      sessionKey: params.session.key,
      participantId: sourceParticipantId,
      requestedUserId,
      wavPath,
      wavBytes: wavBuffer.byteLength,
      sampleRate,
      channels,
    });

    const replyText = await buildAssistantReplyFromAudio({
      accountId: params.session.accountId,
      guildId: params.session.guildId,
      channelId: params.session.channelId,
      userId: requestedUserId,
      wavPath,
    });

    if (!replyText) {
      voiceTrace("no reply text generated for utterance", {
        sessionKey: params.session.key,
        participantId: sourceParticipantId,
        requestedUserId,
      });
      return;
    }

    voiceTrace("reply text generated for utterance", {
      sessionKey: params.session.key,
      participantId: sourceParticipantId,
      requestedUserId,
      textLength: replyText.length,
    });

    await synthesizeAndPlayReply({
      accountId: params.session.accountId,
      connection: params.session.connection,
      text: replyText,
    });
  } catch (error) {
    const runtime = getFluxerRuntime();
    const logger = runtime.logging.getChildLogger({ module: "fluxer.voice" });
    logger.error?.(`utterance processing failed: ${formatErrorMessage(error)}`, {
      sessionKey: params.session.key,
      participantId: sourceParticipantId,
      requestedUserId,
    });
  } finally {
    state.processing = false;
    await fs.unlink(wavPath).catch(() => undefined);
    voiceTrace("finished utterance processing", {
      sessionKey: params.session.key,
      participantId: sourceParticipantId,
      requestedUserId,
    });
  }
}

function teardownResponderSession(key: string): void {
  const session = voiceResponderSessions.get(key);
  if (!session) return;

  voiceTrace("tearing down voice responder session", {
    key,
    participantCount: session.participants.size,
  });

  for (const entry of session.participants.values()) {
    entry.subscription.stop();
  }
  session.participants.clear();
  session.aliases.clear();
  session.unsubscribedFrameCounts.clear();

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
    voiceTrace("reusing existing responder session", { key });
    return existing;
  }
  if (existing) {
    voiceTrace("replacing responder session due to new connection", { key });
    teardownResponderSession(key);
  }

  voiceTrace("creating responder session", {
    key,
    accountId: params.accountId,
    guildId: params.guildId,
    channelId: params.channelId,
  });

  const session: VoiceResponderSession = {
    key,
    accountId: params.accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    connection: params.connection,
    participants: new Map(),
    aliases: new Map(),
    unsubscribedFrameCounts: new Map(),
    queue: Promise.resolve(),
    onAudioFrame: (frame) => {
      const state = resolveParticipantStateForIncoming(session, frame.participantId);
      if (!state) {
        const nextCount = (session.unsubscribedFrameCounts.get(frame.participantId) ?? 0) + 1;
        session.unsubscribedFrameCounts.set(frame.participantId, nextCount);
        if (nextCount === 1 || nextCount % 200 === 0) {
          voiceTrace(`audio frame for unsubscribed participant: ${frame.participantId}`, {
            sessionKey: session.key,
            participantId: frame.participantId,
            frameCount: nextCount,
            subscribedUsers: Array.from(session.participants.values()).map(
              (state) => state.requestedUserId,
            ),
            sourceParticipantIds: Array.from(session.participants.keys()),
          });
        }
        return;
      }
      const nowMs = Date.now();
      if (!state.collecting) {
        state.collecting = true;
        if (!state.utteranceStartedAtMs) state.utteranceStartedAtMs = nowMs;
        voiceTrace("collecting started from first frame", {
          sessionKey: session.key,
          participantId: frame.participantId,
          requestedUserId: state.requestedUserId,
        });
      }

      state.sampleRate = frame.sampleRate;
      state.channels = frame.channels;
      state.totalSamples += frame.samples.length;
      state.frameCount += 1;
      state.chunks.push(frame.samples.slice());

      if (state.frameCount % 100 === 0) {
        voiceTrace("audio frames flowing", {
          sessionKey: session.key,
          participantId: frame.participantId,
          frameCount: state.frameCount,
          totalSamples: state.totalSamples,
        });
      }

      if (state.totalSamples > MAX_BUFFER_SAMPLES) {
        while (state.totalSamples > MAX_BUFFER_SAMPLES && state.chunks.length > 0) {
          const removed = state.chunks.shift();
          if (!removed) break;
          state.totalSamples -= removed.length;
        }
      }
    },
    onSpeakerStart: ({ participantId }) => {
      const state = resolveParticipantStateForIncoming(session, participantId);
      if (!state) {
        voiceTrace(`speaker start for unsubscribed participant: ${participantId}`, {
          sessionKey: session.key,
          participantId,
          subscribedUsers: Array.from(session.participants.values()).map(
            (state) => state.requestedUserId,
          ),
          sourceParticipantIds: Array.from(session.participants.keys()),
        });
        return;
      }
      const nowMs = Date.now();
      if (state.collecting || state.processing) {
        voiceTrace("speaker start while already collecting/processing (ignored reset)", {
          sessionKey: session.key,
          participantId,
          requestedUserId: state.requestedUserId,
          collecting: state.collecting,
          processing: state.processing,
          totalSamples: state.totalSamples,
        });
        return;
      }

      voiceTrace("speaker start", {
        sessionKey: session.key,
        participantId,
        requestedUserId: state.requestedUserId,
      });
      state.collecting = true;
      state.chunks = [];
      state.totalSamples = 0;
      state.frameCount = 0;
      state.utteranceStartedAtMs = nowMs;
      state.lastUtteranceDurationMs = undefined;
    },
    onSpeakerStop: ({ participantId }) => {
      const state = resolveParticipantStateForIncoming(session, participantId);
      if (!state) {
        voiceTrace(`speaker stop for unsubscribed participant: ${participantId}`, {
          sessionKey: session.key,
          participantId,
          subscribedUsers: Array.from(session.participants.values()).map(
            (state) => state.requestedUserId,
          ),
          sourceParticipantIds: Array.from(session.participants.keys()),
        });
        return;
      }
      const nowMs = Date.now();
      if (!state.collecting && state.totalSamples === 0) {
        voiceTrace("speaker stop with no active collection", {
          sessionKey: session.key,
          participantId,
          requestedUserId: state.requestedUserId,
        });
        return;
      }

      if (!state.utteranceStartedAtMs) {
        state.utteranceStartedAtMs = nowMs;
      }
      const utteranceDurationMs = Math.max(0, nowMs - state.utteranceStartedAtMs);
      state.lastUtteranceDurationMs = utteranceDurationMs;
      state.collecting = false;

      voiceTrace("speaker stop", {
        sessionKey: session.key,
        participantId,
        requestedUserId: state.requestedUserId,
        totalSamples: state.totalSamples,
        frameCount: state.frameCount,
        utteranceDurationMs,
      });
      const sourceParticipantId = state.sourceParticipantId;
      session.queue = session.queue
        .then(() => processSpeakerUtterance({ session, participantId: sourceParticipantId }))
        .catch((error) => {
          voiceWarn("queued utterance processing failed", {
            sessionKey: session.key,
            participantId: sourceParticipantId,
            requestedUserId: state.requestedUserId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    onDisconnect: () => {
      voiceWarn("voice connection disconnected; tearing down responder session", { key });
      teardownResponderSession(key);
    },
  };

  params.connection.on("audioFrame", session.onAudioFrame);
  params.connection.on("speakerStart", session.onSpeakerStart);
  params.connection.on("speakerStop", session.onSpeakerStop);
  params.connection.on("disconnect", session.onDisconnect);

  const room = (params.connection as any).room;
  const remoteParticipantIds = room?.remoteParticipants
    ? Array.from(room.remoteParticipants.keys())
    : [];

  voiceResponderSessions.set(key, session);
  voiceTrace("responder session active", {
    key,
    remoteParticipantIds,
  });
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
    voiceTrace("reusing cached voice client", { accountId: account.accountId });
    await waitForClientReady(existing.client).catch((error) => {
      voiceWarn("cached voice client ready wait failed", {
        accountId: account.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { accountId: account.accountId, client: existing.client };
  }

  voiceTrace("creating new voice client", { accountId: account.accountId, baseUrl });

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

  voiceTrace("voice client connected", {
    accountId: account.accountId,
    userId: client.user?.id,
  });

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

  voiceTrace("joining voice channel", {
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    channelType: channel?.type,
    channelGuildId: channel?.guildId,
  });

  const voiceManager = getVoiceManager(client as any);
  await voiceManager.join(channel);

  voiceTrace("voice channel joined", {
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
  });

  return { ok: true, accountId, guildId: params.guildId, channelId: params.channelId };
}

export async function voiceLeaveFluxer(params: {
  guildId: string;
  accountId?: string;
}): Promise<{ ok: true; accountId: string; guildId: string }> {
  const { accountId, client } = await ensureVoiceClient(params.accountId);
  const voiceManager = getVoiceManager(client as any);

  voiceTrace("leaving voice guild", {
    accountId,
    guildId: params.guildId,
  });

  const keysToTearDown: string[] = [];
  for (const [key, session] of voiceResponderSessions.entries()) {
    if (session.accountId === accountId && session.guildId === params.guildId) {
      keysToTearDown.push(key);
    }
  }
  for (const key of keysToTearDown) teardownResponderSession(key);

  voiceManager.leave(params.guildId);
  voiceTrace("left voice guild", {
    accountId,
    guildId: params.guildId,
  });
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

  voiceTrace("voice status checked", {
    accountId,
    guildId: params.guildId,
    userId: params.userId,
    voiceChannelId,
    botConnected,
  });

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

  voiceTrace("subscribe requested", {
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
  });

  let connection = voiceManager.getConnection?.(params.channelId);
  if (!connection) {
    voiceTrace("no active voice connection found for subscribe; joining channel", {
      accountId,
      channelId: params.channelId,
    });
    const anyClient = client as any;
    const channel = await anyClient.channels.fetch(params.channelId);
    if (!channel) {
      throw new Error(`Fluxer voice channel not found: ${params.channelId}`);
    }
    connection = await voiceManager.join(channel);
  }

  if (!(connection instanceof LiveKitRtcConnection)) {
    voiceWarn("subscribe failed: non-livekit connection", {
      accountId,
      channelId: params.channelId,
    });
    throw new Error("Fluxer voice subscribe requires a LiveKit voice connection");
  }

  const session = ensureResponderSession({
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    connection,
  });

  const room = (connection as any).room;
  const remoteParticipantIds: string[] = room?.remoteParticipants
    ? (Array.from(room.remoteParticipants.keys()) as string[])
    : [];
  const resolvedParticipantId = resolveLiveKitParticipantId({
    requestedUserId: params.userId,
    remoteParticipantIds,
  });

  voiceTrace("subscribe remote participant snapshot", {
    accountId,
    sessionKey: session.key,
    requestedUserId: params.userId,
    resolvedParticipantId,
    remoteParticipantIds,
  });

  const existingKey = session.aliases.get(params.userId) ?? params.userId;
  const existing = session.participants.get(existingKey);
  if (existing) {
    voiceTrace("subscribe skipped: already subscribed", {
      accountId,
      sessionKey: session.key,
      userId: params.userId,
      sourceParticipantId: existing.sourceParticipantId,
    });
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: (Array.from(session.participants.values()) as ParticipantAudioState[]).map(
        (state) => state.requestedUserId,
      ),
    };
  }

  const subscription = connection.subscribeParticipantAudio(resolvedParticipantId, {
    autoResubscribe: true,
  });

  session.participants.set(resolvedParticipantId, {
    subscription,
    requestedUserId: params.userId,
    sourceParticipantId: resolvedParticipantId,
    sampleRate: 48_000,
    channels: 1,
    chunks: [],
    totalSamples: 0,
    processing: false,
    frameCount: 0,
    collecting: false,
    utteranceStartedAtMs: undefined,
    lastUtteranceDurationMs: undefined,
  });
  session.aliases.set(params.userId, resolvedParticipantId);

  const activeSubscriptions = (Array.from(session.participants.values()) as ParticipantAudioState[]).map(
    (state) => state.requestedUserId,
  );
  voiceTrace("subscribe succeeded", {
    accountId,
    sessionKey: session.key,
    userId: params.userId,
    sourceParticipantId: resolvedParticipantId,
    activeSubscriptions,
    remoteParticipantPresent: remoteParticipantIds.includes(resolvedParticipantId),
  });

  return {
    ok: true,
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    activeSubscriptions,
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

  voiceTrace("unsubscribe requested", {
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    sessionKey: key,
  });

  if (!session) {
    voiceTrace("unsubscribe skipped: session missing", {
      accountId,
      sessionKey: key,
    });
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: [],
    };
  }

  const participantKey = session.aliases.get(params.userId) ?? params.userId;
  const entry = session.participants.get(participantKey);
  if (entry) {
    entry.subscription.stop();
    session.participants.delete(participantKey);
    session.aliases.delete(params.userId);
    voiceTrace("unsubscribe removed participant", {
      accountId,
      sessionKey: key,
      userId: params.userId,
      sourceParticipantId: participantKey,
    });
  }
  if (session.participants.size === 0) {
    teardownResponderSession(key);
    voiceTrace("unsubscribe emptied session; session removed", {
      accountId,
      sessionKey: key,
    });
    return {
      ok: true,
      accountId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      activeSubscriptions: [],
    };
  }

  const activeSubscriptions = (Array.from(session.participants.values()) as ParticipantAudioState[]).map(
    (state) => state.requestedUserId,
  );
  voiceTrace("unsubscribe completed", {
    accountId,
    sessionKey: key,
    userId: params.userId,
    activeSubscriptions,
  });

  return {
    ok: true,
    accountId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    activeSubscriptions,
  };
}
