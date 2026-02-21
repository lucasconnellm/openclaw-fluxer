"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  LiveKitRtcConnection: () => LiveKitRtcConnection,
  VoiceConnection: () => VoiceConnection,
  VoiceManager: () => VoiceManager,
  getVoiceManager: () => getVoiceManager,
  joinVoiceChannel: () => joinVoiceChannel
});
module.exports = __toCommonJS(index_exports);

// src/VoiceManager.ts
var import_events3 = require("events");
var import_core = require("@fluxerjs/core");
var import_types = require("@fluxerjs/types");

// src/streamPreviewPlaceholder.ts
var MINIMAL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
var thumbnail = MINIMAL_PNG_BASE64;

// src/VoiceConnection.ts
var import_events = require("events");
var nacl = __toESM(require("tweetnacl"));
var dgram = __toESM(require("dgram"));
var ws = __toESM(require("ws"));
var import_node_stream = require("stream");
var import_prism_media = require("prism-media");
var VOICE_WS_OPCODES = {
  Identify: 0,
  SelectProtocol: 1,
  Ready: 2,
  Heartbeat: 3,
  SessionDescription: 4,
  Speaking: 5
};
var VOICE_VERSION = 4;
var CHANNELS = 2;
var OPUS_FRAME_TICKS = 960 * (CHANNELS === 2 ? 2 : 1);
var AUDIO_FRAME_INTERVAL_MS = 20;
async function logFullResponse(url) {
  try {
    const fetchUrl = url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    const res = await fetch(fetchUrl, { method: "GET" });
    const body = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    console.error("[voice] Full response from", url, {
      status: res.status,
      statusText: res.statusText,
      headers,
      body: body.slice(0, 2e3) + (body.length > 2e3 ? "..." : "")
    });
  } catch (e) {
    console.error("[voice] Could not fetch URL for logging:", e);
  }
}
var VoiceConnection = class extends import_events.EventEmitter {
  client;
  channel;
  guildId;
  _sessionId = null;
  _token = null;
  _endpoint = null;
  _userId;
  voiceWs = null;
  udpSocket = null;
  ssrc = 0;
  secretKey = null;
  heartbeatInterval = null;
  sequence = 0;
  timestamp = 0;
  _playing = false;
  _destroyed = false;
  currentStream = null;
  remoteUdpAddress = "";
  remoteUdpPort = 0;
  audioPacketQueue = [];
  pacingInterval = null;
  constructor(client, channel, userId) {
    super();
    this.client = client;
    this.channel = channel;
    this.guildId = channel.guildId;
    this._userId = userId;
  }
  /** Discord voice session ID. */
  get sessionId() {
    return this._sessionId;
  }
  /** Whether audio is currently playing. */
  get playing() {
    return this._playing;
  }
  /** Called when we have both server update and state update. */
  async connect(server, state) {
    this._token = server.token;
    const raw = (server.endpoint ?? "").trim();
    this._sessionId = state.session_id;
    if (!raw || !this._token || !this._sessionId) {
      this.emit("error", new Error("Missing voice server or session data"));
      return;
    }
    let wsUrl;
    if (raw.includes("?")) {
      wsUrl = /^wss?:\/\//i.test(raw) ? raw : raw.replace(/^https?:\/\//i, "wss://");
      if (!/^wss?:\/\//i.test(wsUrl)) wsUrl = `wss://${wsUrl}`;
    } else {
      const normalized = raw.replace(/^(wss|ws|https?):\/\//i, "").replace(/^\/+/, "") || raw;
      wsUrl = `wss://${normalized}?v=${VOICE_VERSION}`;
    }
    const hostPart = raw.replace(/^(wss|ws|https?):\/\//i, "").replace(/^\/+/, "").split("/")[0] ?? "";
    this._endpoint = hostPart.split("?")[0] || hostPart;
    const WS = await this.getWebSocketConstructor();
    this.voiceWs = new WS(wsUrl);
    return new Promise((resolve, reject) => {
      const resolveReady = () => {
        cleanup();
        resolve();
        this.emit("ready");
      };
      const onOpen = () => {
        this.voiceWs.off("error", onError);
        this.sendVoiceOp(VOICE_WS_OPCODES.Identify, {
          server_id: this.guildId,
          user_id: this._userId,
          session_id: this._sessionId,
          token: this._token
        });
      };
      const onError = (err) => {
        if (err instanceof Error && /Unexpected server response/i.test(err.message)) {
          logFullResponse(wsUrl).catch(() => {
          });
        }
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onMessage = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const payload = JSON.parse(buf.toString());
        const op = payload.op;
        const d = payload.d;
        if (op === VOICE_WS_OPCODES.Ready) {
          this.ssrc = d.ssrc;
          const port = d.port;
          const address = d.address ?? this._endpoint.split(":")[0];
          this.remoteUdpAddress = address;
          this.remoteUdpPort = port;
          this.setupUDP(address, port, () => {
          });
        } else if (op === VOICE_WS_OPCODES.SessionDescription) {
          this.secretKey = new Uint8Array(d.secret_key);
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
          }
          this.heartbeatInterval = setInterval(() => {
            this.sendVoiceOp(VOICE_WS_OPCODES.Heartbeat, Date.now());
          }, d.heartbeat_interval ?? 5e3);
          resolveReady();
        } else if (op === VOICE_WS_OPCODES.Heartbeat) {
        }
      };
      const cleanup = () => {
        if (this.voiceWs) {
          this.voiceWs.removeAllListeners();
        }
      };
      const ws2 = this.voiceWs;
      ws2.on("open", onOpen);
      ws2.on("error", onError);
      ws2.on("message", (data) => onMessage(data));
      ws2.once("close", () => {
        cleanup();
        if (!this._destroyed) reject(new Error("Voice WebSocket closed"));
      });
    });
  }
  async getWebSocketConstructor() {
    try {
      return ws.default;
    } catch {
      throw new Error('Install "ws" for voice support: pnpm add ws');
    }
  }
  sendVoiceOp(op, d) {
    if (!this.voiceWs || this.voiceWs.readyState !== 1) return;
    this.voiceWs.send(JSON.stringify({ op, d }));
  }
  setupUDP(remoteAddress, remotePort, onReady) {
    const socket = dgram.createSocket("udp4");
    this.udpSocket = socket;
    const discovery = Buffer.alloc(70);
    discovery.writeUInt32BE(1, 0);
    discovery.writeUInt16BE(70, 4);
    discovery.writeUInt32BE(this.ssrc, 6);
    socket.send(discovery, 0, discovery.length, remotePort, remoteAddress, () => {
      socket.once("message", (msg) => {
        if (msg.length < 70) {
          this.emit("error", new Error("UDP discovery response too short"));
          return;
        }
        const len = msg.readUInt16BE(4);
        let ourIp = "";
        let i = 10;
        while (i < Math.min(70, len + 8) && msg[i] !== 0) {
          ourIp += String.fromCharCode(msg[i]);
          i++;
        }
        const ourPort = msg.readUInt16BE(68);
        this.sendVoiceOp(VOICE_WS_OPCODES.SelectProtocol, {
          protocol: "udp",
          data: {
            address: ourIp,
            port: ourPort,
            mode: "xsalsa20_poly1305"
          }
        });
        onReady();
      });
    });
  }
  /**
   * Play a stream of raw Opus packets
   * Uses the same queue and 20ms pacing as play(). Use this for local files (MP3 → PCM → Opus) or other Opus sources.
   */
  playOpus(stream) {
    this.stop();
    this._playing = true;
    this.currentStream = stream;
    this.audioPacketQueue = [];
    this.sendVoiceOp(VOICE_WS_OPCODES.Speaking, { speaking: 1, delay: 0 });
    const stopPacing = () => {
      if (this.pacingInterval) {
        clearInterval(this.pacingInterval);
        this.pacingInterval = null;
      }
    };
    this.pacingInterval = setInterval(() => {
      const packet = this.audioPacketQueue.shift();
      if (packet && this.secretKey && this.udpSocket) this.sendAudioFrame(packet);
      if (this.audioPacketQueue.length === 0 && !this._playing) stopPacing();
    }, AUDIO_FRAME_INTERVAL_MS);
    stream.on("data", (chunk) => {
      if (!this._playing) return;
      if (Buffer.isBuffer(chunk) && chunk.length > 0) this.audioPacketQueue.push(chunk);
    });
    stream.on("error", (err) => {
      this._playing = false;
      this.currentStream = null;
      stopPacing();
      this.emit("error", err);
    });
    stream.on("end", () => {
      this._playing = false;
      this.currentStream = null;
      if (this.audioPacketQueue.length === 0) stopPacing();
    });
  }
  /**
   * Play a direct WebM/Opus URL or stream. Fetches the URL (if string), demuxes with prism-media WebmDemuxer,
   * and sends Opus packets to the voice connection. No FFmpeg or encoding; input must be WebM with Opus.
   */
  async play(urlOrStream) {
    this.stop();
    let inputStream;
    if (typeof urlOrStream === "string") {
      try {
        const response = await fetch(urlOrStream);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error("No response body");
        inputStream = import_node_stream.Readable.fromWeb(response.body);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.emit("error", err);
        return;
      }
    } else {
      inputStream = urlOrStream;
    }
    const demuxer = new import_prism_media.opus.WebmDemuxer();
    inputStream.pipe(demuxer);
    this._playing = true;
    this.currentStream = demuxer;
    this.audioPacketQueue = [];
    this.sendVoiceOp(VOICE_WS_OPCODES.Speaking, { speaking: 1, delay: 0 });
    const stopPacing = () => {
      if (this.pacingInterval) {
        clearInterval(this.pacingInterval);
        this.pacingInterval = null;
      }
    };
    this.pacingInterval = setInterval(() => {
      const packet = this.audioPacketQueue.shift();
      if (packet && this.secretKey && this.udpSocket) this.sendAudioFrame(packet);
      if (this.audioPacketQueue.length === 0 && !this._playing) stopPacing();
    }, AUDIO_FRAME_INTERVAL_MS);
    demuxer.on("data", (chunk) => {
      if (!this._playing) return;
      if (Buffer.isBuffer(chunk) && chunk.length > 0) this.audioPacketQueue.push(chunk);
    });
    demuxer.on("error", (err) => {
      this._playing = false;
      this.currentStream = null;
      stopPacing();
      this.emit("error", err);
    });
    demuxer.on("end", () => {
      this._playing = false;
      this.currentStream = null;
      if (this.audioPacketQueue.length === 0) stopPacing();
    });
  }
  sendAudioFrame(opusPayload) {
    if (!this.udpSocket || !this.secretKey) return;
    const rtpHeader = Buffer.alloc(12);
    rtpHeader[0] = 128;
    rtpHeader[1] = 120;
    rtpHeader.writeUInt16BE(this.sequence++, 2);
    rtpHeader.writeUInt32BE(this.timestamp, 4);
    rtpHeader.writeUInt32BE(this.ssrc, 8);
    this.timestamp += OPUS_FRAME_TICKS;
    const nonce = Buffer.alloc(24);
    rtpHeader.copy(nonce, 0, 0, 12);
    const encrypted = nacl.secretbox(opusPayload, new Uint8Array(nonce), this.secretKey);
    const packet = Buffer.concat([rtpHeader, Buffer.from(encrypted)]);
    if (this.remoteUdpPort && this.remoteUdpAddress && this.udpSocket) {
      this.udpSocket.send(packet, 0, packet.length, this.remoteUdpPort, this.remoteUdpAddress);
    }
  }
  /** Stop playback and clear the queue. */
  stop() {
    this._playing = false;
    this.audioPacketQueue = [];
    if (this.pacingInterval) {
      clearInterval(this.pacingInterval);
      this.pacingInterval = null;
    }
    if (this.currentStream) {
      if (typeof this.currentStream.destroy === "function") this.currentStream.destroy();
      this.currentStream = null;
    }
  }
  /** Disconnect from voice (closes WebSocket and UDP). */
  disconnect() {
    this._destroyed = true;
    this.stop();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.voiceWs) {
      this.voiceWs.close();
      this.voiceWs = null;
    }
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    this.emit("disconnect");
  }
  /** Disconnect and remove all listeners. */
  destroy() {
    if (this.currentStream) {
      if (typeof this.currentStream.destroy === "function") this.currentStream.destroy();
      this.currentStream = null;
    }
    this.disconnect();
    this.removeAllListeners();
  }
};

// src/LiveKitRtcConnection.ts
var import_node_child_process = require("child_process");
var import_events2 = require("events");
var import_rtc_node = require("@livekit/rtc-node");

// src/livekit.ts
function isLiveKitEndpoint(endpoint, token) {
  if (!endpoint || typeof endpoint !== "string") return false;
  const s = endpoint.trim();
  if (s.includes("access_token=") || s.includes("/rtc") && s.includes("?")) return true;
  if (token && !s.includes("?")) return true;
  return false;
}
function buildLiveKitUrlForRtcSdk(endpoint) {
  const base = endpoint.replace(/^(wss|ws|https?):\/\//i, "").replace(/^\/+/, "").split("/")[0] ?? endpoint;
  const scheme = /^wss?:\/\//i.test(endpoint) ? endpoint.startsWith("wss") ? "wss" : "ws" : "wss";
  return `${scheme}://${base.replace(/\/+$/, "")}`;
}

// src/opusUtils.ts
function parseOpusPacketBoundaries(buffer) {
  if (buffer.length < 2) return null;
  const toc = buffer[0];
  const c = toc & 3;
  const tocSingle = toc & 252 | 0;
  if (c === 0) {
    return { frames: [buffer.slice()], consumed: buffer.length };
  }
  if (c === 1) {
    if (buffer.length < 2) return null;
    const L1 = buffer[1] + 1;
    if (buffer.length < 2 + L1) return null;
    const L2 = buffer.length - 2 - L1;
    const frame0 = new Uint8Array(1 + L1);
    frame0[0] = tocSingle;
    frame0.set(buffer.subarray(2, 2 + L1), 1);
    const frame1 = new Uint8Array(1 + L2);
    frame1[0] = tocSingle;
    frame1.set(buffer.subarray(2 + L1), 1);
    return { frames: [frame0, frame1], consumed: buffer.length };
  }
  if (c === 2) {
    if (buffer.length < 3) return null;
    const frameLen = Math.floor((buffer.length - 2) / 2);
    if (frameLen < 1) return null;
    const frame0 = new Uint8Array(1 + frameLen);
    frame0[0] = tocSingle;
    frame0.set(buffer.subarray(2, 2 + frameLen), 1);
    const frame1 = new Uint8Array(1 + frameLen);
    frame1[0] = tocSingle;
    frame1.set(buffer.subarray(2 + frameLen, 2 + 2 * frameLen), 1);
    return { frames: [frame0, frame1], consumed: 2 + 2 * frameLen };
  }
  if (c === 3) {
    if (buffer.length < 2) return null;
    const N = buffer[1];
    if (N < 1 || N > 255) return null;
    const numLengthBytes = N - 1;
    if (buffer.length < 2 + numLengthBytes) return null;
    const lengths = [];
    for (let i = 0; i < numLengthBytes; i++) {
      lengths.push(buffer[2 + i] + 1);
    }
    const headerLen = 2 + numLengthBytes;
    let offset = headerLen;
    const sumKnown = lengths.reduce((a, b) => a + b, 0);
    const lastLen = buffer.length - headerLen - sumKnown;
    if (lastLen < 0) return null;
    lengths.push(lastLen);
    const frames = [];
    for (let i = 0; i < lengths.length; i++) {
      const L = lengths[i];
      if (offset + L > buffer.length) return null;
      const frame = new Uint8Array(1 + L);
      frame[0] = tocSingle;
      frame.set(buffer.subarray(offset, offset + L), 1);
      frames.push(frame);
      offset += L;
    }
    return { frames, consumed: offset };
  }
  return null;
}
function concatUint8Arrays(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// src/LiveKitRtcConnection.ts
var import_node_stream2 = require("stream");
var import_opus_decoder = require("opus-decoder");
var import_prism_media2 = require("prism-media");
var import_node_util = require("util");
var import_mp4box = require("mp4box");
var SAMPLE_RATE = 48e3;
var CHANNELS2 = 1;
function getNaluByteLength(nalu) {
  if (ArrayBuffer.isView(nalu)) return nalu.byteLength;
  if (nalu instanceof ArrayBuffer) return nalu.byteLength;
  if (Array.isArray(nalu)) return nalu.length;
  return 0;
}
function toUint8Array(nalu) {
  if (nalu instanceof Uint8Array) return nalu;
  if (ArrayBuffer.isView(nalu))
    return new Uint8Array(nalu.buffer, nalu.byteOffset, nalu.byteLength);
  if (nalu instanceof ArrayBuffer) return new Uint8Array(nalu);
  if (Array.isArray(nalu)) return new Uint8Array(nalu);
  return new Uint8Array(0);
}
function buildAvcDecoderConfig(avcC) {
  try {
    let size = 6;
    for (const s of avcC.SPS) size += 2 + getNaluByteLength(s.nalu);
    size += 1;
    for (const p of avcC.PPS) size += 2 + getNaluByteLength(p.nalu);
    if (avcC.ext) size += getNaluByteLength(avcC.ext);
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const arr = new Uint8Array(buf);
    let offset = 0;
    view.setUint8(offset++, avcC.configurationVersion);
    view.setUint8(offset++, avcC.AVCProfileIndication);
    view.setUint8(offset++, avcC.profile_compatibility);
    view.setUint8(offset++, avcC.AVCLevelIndication);
    view.setUint8(offset++, avcC.lengthSizeMinusOne & 3 | 252);
    view.setUint8(offset++, avcC.SPS.length & 31 | 224);
    for (const s of avcC.SPS) {
      const naluBytes = toUint8Array(s.nalu);
      const naluLen = naluBytes.byteLength;
      if (offset + 2 + naluLen > size) return void 0;
      view.setUint16(offset, naluLen, false);
      offset += 2;
      arr.set(naluBytes, offset);
      offset += naluLen;
    }
    view.setUint8(offset++, avcC.PPS.length);
    for (const p of avcC.PPS) {
      const naluBytes = toUint8Array(p.nalu);
      const naluLen = naluBytes.byteLength;
      if (offset + 2 + naluLen > size) return void 0;
      view.setUint16(offset, naluLen, false);
      offset += 2;
      arr.set(naluBytes, offset);
      offset += naluLen;
    }
    if (avcC.ext) {
      const extBytes = toUint8Array(avcC.ext);
      if (offset + extBytes.byteLength > size) return void 0;
      arr.set(extBytes, offset);
    }
    return buf;
  } catch {
    return void 0;
  }
}
var FRAME_SAMPLES = 480;
function floatToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (!Number.isFinite(s)) {
      int16[i] = 0;
      continue;
    }
    s = Math.max(-1, Math.min(1, s));
    const scale = s < 0 ? 32768 : 32767;
    const dither = (Math.random() + Math.random() - 1) * 0.5;
    const scaled = Math.round(s * scale + dither);
    int16[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return int16;
}
function applyVolumeToInt16(samples, volumePercent) {
  const vol = (volumePercent ?? 100) / 100;
  if (vol === 1) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * vol)));
  }
  return out;
}
var VOICE_DEBUG = process.env.VOICE_DEBUG === "1" || process.env.VOICE_DEBUG === "true";
var LiveKitRtcConnection = class extends import_events2.EventEmitter {
  client;
  channel;
  guildId;
  _volume = 100;
  _playing = false;
  _playingVideo = false;
  _destroyed = false;
  room = null;
  audioSource = null;
  audioTrack = null;
  videoSource = null;
  videoTrack = null;
  currentStream = null;
  currentVideoStream = null;
  _videoCleanup = null;
  lastServerEndpoint = null;
  lastServerToken = null;
  _disconnectEmitted = false;
  receiveSubscriptions = /* @__PURE__ */ new Map();
  participantTrackSids = /* @__PURE__ */ new Map();
  activeSpeakers = /* @__PURE__ */ new Set();
  /**
   * @param client - The Fluxer client instance
   * @param channel - The voice channel to connect to
   * @param _userId - The user ID (reserved for future use)
   */
  constructor(client, channel, _userId) {
    super();
    this.client = client;
    this.channel = channel;
    this.guildId = channel.guildId;
  }
  /** Whether audio is currently playing. */
  get playing() {
    return this._playing;
  }
  debug(msg, data) {
    if (VOICE_DEBUG) {
      console.debug("[voice LiveKitRtc]", msg, data ?? "");
    }
  }
  audioDebug(msg, data) {
    if (VOICE_DEBUG) {
      console.error("[voice LiveKitRtc audio]", msg, data ?? "");
    }
  }
  emitDisconnect(source) {
    if (this._disconnectEmitted) return;
    this._disconnectEmitted = true;
    this.debug("emitting disconnect", { source });
    this.emit("disconnect");
  }
  /** Returns true if the LiveKit room is connected and not destroyed. */
  isConnected() {
    return !this._destroyed && this.room != null && this.room.isConnected;
  }
  /**
   * Returns true if we're already connected to the given server (skip migration).
   * @param endpoint - Voice server endpoint from the gateway
   * @param token - Voice server token
   */
  isSameServer(endpoint, token) {
    const ep = (endpoint ?? "").trim();
    return ep === (this.lastServerEndpoint ?? "") && token === (this.lastServerToken ?? "");
  }
  /** Set playback volume (0-200, 100 = normal). Affects current and future playback. */
  setVolume(volumePercent) {
    this._volume = Math.max(0, Math.min(200, volumePercent ?? 100));
  }
  /** Get current volume (0-200). */
  getVolume() {
    return this._volume ?? 100;
  }
  isAudioTrack(track) {
    return track.kind === import_rtc_node.TrackKind.KIND_AUDIO;
  }
  getParticipantId(participant) {
    return participant.identity;
  }
  subscribeParticipantTrack(participant, track) {
    if (!this.isAudioTrack(track)) return;
    const participantId = this.getParticipantId(participant);
    const current = this.receiveSubscriptions.get(participantId);
    if (current) current.stop();
    const audioStream = new import_rtc_node.AudioStream(track, {
      sampleRate: SAMPLE_RATE,
      numChannels: CHANNELS2,
      frameSizeMs: 10
    });
    let stopped = false;
    const pump = async () => {
      try {
        const reader = audioStream.getReader();
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          this.emit("audioFrame", {
            participantId,
            trackSid: track.sid,
            sampleRate: value.sampleRate,
            channels: value.channels,
            samples: value.data
          });
        }
      } catch (err) {
        if (!stopped) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    const stop = () => {
      stopped = true;
      audioStream.cancel().catch(() => {
      });
      this.receiveSubscriptions.delete(participantId);
    };
    this.receiveSubscriptions.set(participantId, { participantId, stop });
    this.participantTrackSids.set(participantId, track.sid ?? "");
    void pump();
  }
  subscribeParticipantAudio(participantId, options = {}) {
    const stop = () => {
      this.receiveSubscriptions.get(participantId)?.stop();
      this.receiveSubscriptions.delete(participantId);
      this.participantTrackSids.delete(participantId);
    };
    const room = this.room;
    if (!room || !room.isConnected) return { participantId, stop };
    const participant = room.remoteParticipants.get(participantId);
    if (!participant) return { participantId, stop };
    for (const pub of participant.trackPublications.values()) {
      const maybeTrack = pub.track;
      if (maybeTrack && this.isAudioTrack(maybeTrack)) {
        this.subscribeParticipantTrack(participant, maybeTrack);
        break;
      }
    }
    if (options.autoResubscribe === false && !this.receiveSubscriptions.has(participantId)) {
      return { participantId, stop };
    }
    return { participantId, stop };
  }
  clearReceiveSubscriptions() {
    for (const sub of this.receiveSubscriptions.values()) sub.stop();
    this.receiveSubscriptions.clear();
    this.participantTrackSids.clear();
    this.activeSpeakers.clear();
  }
  playOpus(_stream) {
    this.emit(
      "error",
      new Error("LiveKit: playOpus not supported; use play(url) with a WebM/Opus URL")
    );
  }
  /**
   * Connect to the LiveKit room using voice server and state from the gateway.
   * Called internally by VoiceManager; typically not used directly.
   *
   * @param server - Voice server update data (endpoint, token)
   * @param _state - Voice state update data (session, channel)
   */
  async connect(server, _state) {
    const raw = (server.endpoint ?? "").trim();
    const token = server.token;
    if (!raw || !token) {
      this.emit("error", new Error("Missing voice server endpoint or token"));
      return;
    }
    const url = buildLiveKitUrlForRtcSdk(raw);
    this._disconnectEmitted = false;
    try {
      const room = new import_rtc_node.Room();
      this.room = room;
      room.on(import_rtc_node.RoomEvent.Disconnected, () => {
        this.debug("Room disconnected");
        this.lastServerEndpoint = null;
        this.lastServerToken = null;
        setImmediate(() => this.emit("serverLeave"));
        this.emitDisconnect("room_disconnected");
      });
      room.on(import_rtc_node.RoomEvent.Reconnecting, () => {
        this.debug("Room reconnecting");
      });
      room.on(import_rtc_node.RoomEvent.Reconnected, () => {
        this.debug("Room reconnected");
      });
      room.on(import_rtc_node.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (!this.isAudioTrack(track)) return;
        this.subscribeParticipantTrack(participant, track);
      });
      room.on(import_rtc_node.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        if (!this.isAudioTrack(track)) return;
        const participantId = this.getParticipantId(participant);
        this.receiveSubscriptions.get(participantId)?.stop();
        this.receiveSubscriptions.delete(participantId);
        this.participantTrackSids.delete(participantId);
      });
      room.on(import_rtc_node.RoomEvent.ParticipantDisconnected, (participant) => {
        const participantId = this.getParticipantId(participant);
        this.receiveSubscriptions.get(participantId)?.stop();
        this.receiveSubscriptions.delete(participantId);
        this.participantTrackSids.delete(participantId);
        if (this.activeSpeakers.delete(participantId)) {
          this.emit("speakerStop", { participantId });
        }
      });
      room.on(import_rtc_node.RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const next = new Set(speakers.map((speaker) => speaker.identity));
        for (const participantId of next) {
          if (!this.activeSpeakers.has(participantId)) {
            this.emit("speakerStart", { participantId });
          }
        }
        for (const participantId of this.activeSpeakers) {
          if (!next.has(participantId)) {
            this.emit("speakerStop", { participantId });
          }
        }
        this.activeSpeakers.clear();
        for (const participantId of next) this.activeSpeakers.add(participantId);
      });
      await room.connect(url, token, { autoSubscribe: true, dynacast: false });
      this.lastServerEndpoint = raw;
      this.lastServerToken = token;
      this.debug("connected to room");
      this.emit("ready");
    } catch (e) {
      this.room = null;
      const err = e instanceof Error ? e : new Error(String(e));
      this.emit("error", err);
      throw err;
    }
  }
  /** Whether a video track is currently playing in the voice channel. */
  get playingVideo() {
    return this._playingVideo;
  }
  /**
   * Play video from an MP4 URL or buffer. Streams decoded frames to the LiveKit room as a video track.
   * Uses node-webcodecs for decoding (no ffmpeg). Supports H.264 (avc1) and H.265 (hvc1/hev1) codecs.
   *
   * @param urlOrBuffer - Video source: HTTP(S) URL to an MP4 file, or raw ArrayBuffer/Uint8Array of MP4 data
   * @param options - Optional playback options (see {@link VideoPlayOptions})
   * @emits error - On fetch failure, missing video track, or decode errors
   *
   * @example
   * ```ts
   * const conn = await voiceManager.join(channel);
   * if (conn instanceof LiveKitRtcConnection && conn.isConnected()) {
   *   await conn.playVideo('https://example.com/video.mp4', { source: 'camera' });
   * }
   * ```
   */
  async playVideo(urlOrBuffer, options) {
    this.stopVideo();
    if (!this.room || !this.room.isConnected) {
      this.emit("error", new Error("LiveKit: not connected"));
      return;
    }
    let useFFmpeg = options?.useFFmpeg ?? process.env.FLUXER_VIDEO_FFMPEG === "1";
    if (options?.resolution) useFFmpeg = true;
    if (useFFmpeg && typeof urlOrBuffer === "string") {
      await this.playVideoFFmpeg(urlOrBuffer, options);
      return;
    }
    if (useFFmpeg && (urlOrBuffer instanceof ArrayBuffer || urlOrBuffer instanceof Uint8Array)) {
      this.emit("error", new Error("useFFmpeg requires a URL; buffer/ArrayBuffer not supported"));
      return;
    }
    let VideoDecoder;
    let EncodedVideoChunk;
    try {
      const webcodecs = await import("node-webcodecs");
      VideoDecoder = webcodecs.VideoDecoder;
      EncodedVideoChunk = webcodecs.EncodedVideoChunk;
    } catch {
      this.emit(
        "error",
        new Error(
          "node-webcodecs is not available (optional dependency failed to install). Use options.useFFmpeg with a URL, or install node-webcodecs."
        )
      );
      return;
    }
    const videoUrl = typeof urlOrBuffer === "string" ? urlOrBuffer : null;
    let arrayBuffer;
    if (typeof urlOrBuffer === "string") {
      try {
        const response = await fetch(urlOrBuffer);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buf = await response.arrayBuffer();
        arrayBuffer = buf;
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
        return;
      }
    } else if (urlOrBuffer instanceof Uint8Array) {
      arrayBuffer = urlOrBuffer.buffer.slice(
        urlOrBuffer.byteOffset,
        urlOrBuffer.byteOffset + urlOrBuffer.byteLength
      );
    } else {
      arrayBuffer = urlOrBuffer;
    }
    const file = (0, import_mp4box.createFile)();
    const sourceOption = options?.source ?? "camera";
    const loop = options?.loop ?? true;
    file.onError = (e) => {
      this._playingVideo = false;
      this.emit("error", e);
    };
    file.onReady = (info) => {
      if (!info.tracks?.length) {
        this.emit("error", new Error("No tracks found in MP4 file"));
        return;
      }
      const tracks = info.tracks;
      const videoTrack = tracks.find((t) => t.type === "video");
      if (!videoTrack) {
        this.emit("error", new Error("No video track in MP4"));
        return;
      }
      const audioTrackInfo = tracks.find(
        (t) => t.type === "audio" && t.codec.startsWith("mp4a")
      );
      const width = videoTrack.video?.width ?? 640;
      const height = videoTrack.video?.height ?? 480;
      const totalSamples = videoTrack.nb_samples ?? Number.POSITIVE_INFINITY;
      const source = new import_rtc_node.VideoSource(width, height);
      this.videoSource = source;
      const track = import_rtc_node.LocalVideoTrack.createVideoTrack("video", source);
      this.videoTrack = track;
      let audioSource = null;
      let audioTrack = null;
      let audioFfmpegProc = null;
      const decoderCodec = videoTrack.codec.startsWith("avc1") ? videoTrack.codec : videoTrack.codec.startsWith("hvc1") || videoTrack.codec.startsWith("hev1") ? videoTrack.codec : "avc1.42E01E";
      let decoderDescription;
      if (videoTrack.codec.startsWith("avc1") || videoTrack.codec.startsWith("avc3")) {
        const isoFile = file;
        const trak = isoFile.moov?.traks?.find((t) => t.tkhd.track_id === videoTrack.id);
        const sampleEntry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        const avcC = sampleEntry?.avcC;
        if (avcC) {
          decoderDescription = buildAvcDecoderConfig(avcC);
        }
      }
      if (videoUrl && audioTrackInfo) {
        audioSource = new import_rtc_node.AudioSource(SAMPLE_RATE, CHANNELS2);
        this.audioSource = audioSource;
        audioTrack = import_rtc_node.LocalAudioTrack.createAudioTrack("audio", audioSource);
        this.audioTrack = audioTrack;
      }
      const frameQueue = [];
      let playbackStartMs = null;
      const maxFps = options?.maxFramerate ?? 60;
      const FRAME_INTERVAL_MS = Math.round(1e3 / maxFps);
      const MAX_QUEUED_FRAMES = 30;
      let pacingInterval = null;
      const decoder = new VideoDecoder({
        output: async (frame) => {
          if (!this._playingVideo || !source) return;
          const { codedWidth, codedHeight } = frame;
          if (codedWidth <= 0 || codedHeight <= 0) {
            frame.close();
            if (VOICE_DEBUG)
              this.audioDebug("video frame skipped (invalid dimensions)", {
                codedWidth,
                codedHeight
              });
            return;
          }
          try {
            if (playbackStartMs === null) playbackStartMs = Date.now();
            const frameTimestampUs = frame.timestamp ?? 0;
            const frameTimeMs = frameTimestampUs / 1e3;
            const copyOptions = frame.format !== "I420" ? { format: "I420" } : void 0;
            const size = frame.allocationSize(copyOptions);
            const buffer = new Uint8Array(size);
            await frame.copyTo(buffer, copyOptions);
            frame.close();
            const expectedI420Size = Math.ceil(codedWidth * codedHeight * 3 / 2);
            if (buffer.byteLength < expectedI420Size) {
              if (VOICE_DEBUG)
                this.audioDebug("video frame skipped (buffer too small)", {
                  codedWidth,
                  codedHeight
                });
              return;
            }
            while (frameQueue.length >= MAX_QUEUED_FRAMES) {
              frameQueue.shift();
            }
            frameQueue.push({
              buffer,
              width: codedWidth,
              height: codedHeight,
              timestampMs: frameTimeMs
            });
          } catch (err) {
            if (VOICE_DEBUG) this.audioDebug("video frame error", { error: String(err) });
          }
        },
        error: (e) => {
          this.emit("error", e);
          doCleanup();
        }
      });
      decoder.configure({
        codec: decoderCodec,
        codedWidth: width,
        codedHeight: height,
        ...decoderDescription && { description: decoderDescription }
      });
      let samplesReceived = 0;
      let cleanupCalled = false;
      let currentFile = file;
      const doCleanup = () => {
        if (cleanupCalled) return;
        cleanupCalled = true;
        this._videoCleanup = null;
        this._playingVideo = false;
        if (pacingInterval) {
          clearInterval(pacingInterval);
          pacingInterval = null;
        }
        this.emit("requestVoiceStateSync", { self_stream: false, self_video: false });
        const fileObj = currentFile;
        if (typeof fileObj.stop === "function") {
          fileObj.stop();
        }
        try {
          decoder.close();
        } catch {
        }
        if (audioFfmpegProc && !audioFfmpegProc.killed) {
          audioFfmpegProc.kill("SIGKILL");
          audioFfmpegProc = null;
        }
        this.currentVideoStream = null;
        if (this.videoTrack) {
          this.videoTrack.close().catch(() => {
          });
          this.videoTrack = null;
        }
        if (this.videoSource) {
          this.videoSource.close().catch(() => {
          });
          this.videoSource = null;
        }
        if (audioTrack) {
          audioTrack.close().catch(() => {
          });
          this.audioTrack = null;
        }
        if (audioSource) {
          audioSource.close().catch(() => {
          });
          this.audioSource = null;
        }
      };
      const flushAndCleanup = () => {
        decoder.flush().then(doCleanup).catch(doCleanup);
      };
      const scheduleLoop = (mp4File) => {
        setImmediate(async () => {
          if (!this._playingVideo || cleanupCalled) return;
          try {
            await decoder.flush();
            decoder.reset();
            decoder.configure({
              codec: decoderCodec,
              codedWidth: width,
              codedHeight: height,
              ...decoderDescription && { description: decoderDescription }
            });
            const fileObj = mp4File;
            if (typeof fileObj.stop === "function") fileObj.stop();
          } catch (e) {
            if (VOICE_DEBUG) this.audioDebug("loop reset error", { error: String(e) });
          }
          if (!this._playingVideo || cleanupCalled) return;
          playbackStartMs = null;
          frameQueue.length = 0;
          samplesReceived = 0;
          const loopFile = (0, import_mp4box.createFile)();
          loopFile.onError = (e) => {
            this._playingVideo = false;
            this.emit("error", e);
          };
          loopFile.onReady = (loopInfo) => {
            const loopTracks = loopInfo.tracks ?? [];
            const loopVt = loopTracks.find((t) => t.type === "video");
            if (!loopVt || loopVt.id !== videoTrack.id) return;
            currentFile = loopFile;
            this.currentVideoStream = loopFile;
            loopFile.setExtractionOptions(loopVt.id, null, { nbSamples: 16 });
            loopFile.onSamples = (tid, _u, samp) => {
              if (!this._playingVideo) return;
              if (tid === videoTrack.id) {
                try {
                  for (const sample of samp) {
                    const isKeyFrame = sample.is_sync ?? sample.is_rap ?? sample.dts === 0;
                    const chunk = new EncodedVideoChunk({
                      type: isKeyFrame ? "key" : "delta",
                      timestamp: Math.round(sample.dts / sample.timescale * 1e6),
                      duration: Math.round(sample.duration / sample.timescale * 1e6),
                      data: sample.data
                    });
                    decoder.decode(chunk);
                  }
                } catch (decodeErr) {
                  this.emit(
                    "error",
                    decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr))
                  );
                  doCleanup();
                  return;
                }
                samplesReceived += samp.length;
                if (samplesReceived >= totalSamples) {
                  if (loop) scheduleLoop(loopFile);
                  else flushAndCleanup();
                }
              }
            };
            loopFile.start();
          };
          arrayBuffer.fileStart = 0;
          loopFile.appendBuffer(arrayBuffer);
          loopFile.flush();
        });
      };
      this._videoCleanup = () => {
        doCleanup();
      };
      file.onSamples = (trackId, _user, samples) => {
        if (!this._playingVideo) return;
        if (trackId === videoTrack.id) {
          try {
            for (const sample of samples) {
              const isKeyFrame = sample.is_sync ?? sample.is_rap ?? sample.dts === 0;
              const chunk = new EncodedVideoChunk({
                type: isKeyFrame ? "key" : "delta",
                timestamp: Math.round(sample.dts / sample.timescale * 1e6),
                duration: Math.round(sample.duration / sample.timescale * 1e6),
                data: sample.data
              });
              decoder.decode(chunk);
            }
          } catch (decodeErr) {
            this.emit(
              "error",
              decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr))
            );
            doCleanup();
            return;
          }
          samplesReceived += samples.length;
          if (samplesReceived >= totalSamples) {
            if (loop) scheduleLoop(file);
            else flushAndCleanup();
          }
        }
      };
      const participant = this.room?.localParticipant;
      if (!participant) return;
      const publishOptions = new import_rtc_node.TrackPublishOptions({
        source: sourceOption === "screenshare" ? import_rtc_node.TrackSource.SOURCE_SCREENSHARE : import_rtc_node.TrackSource.SOURCE_CAMERA,
        videoEncoding: {
          maxBitrate: BigInt(options?.videoBitrate ?? 25e5),
          maxFramerate: options?.maxFramerate ?? 60
        }
      });
      const publishVideo = participant.publishTrack(track, publishOptions);
      const audioPublishOptions = new import_rtc_node.TrackPublishOptions();
      audioPublishOptions.source = import_rtc_node.TrackSource.SOURCE_MICROPHONE;
      const publishAudio = audioTrack ? participant.publishTrack(audioTrack, audioPublishOptions) : Promise.resolve();
      Promise.all([publishVideo, publishAudio]).then(async () => {
        this._playingVideo = true;
        this.currentVideoStream = file;
        file.setExtractionOptions(videoTrack.id, null, { nbSamples: 16 });
        pacingInterval = setInterval(() => {
          if (!this._playingVideo || !source || playbackStartMs === null) return;
          const elapsed = Date.now() - playbackStartMs;
          if (frameQueue.length > 10) {
            while (frameQueue.length > 1 && frameQueue[1].timestampMs <= elapsed) {
              frameQueue.shift();
            }
          }
          if (frameQueue.length > 0 && frameQueue[0].timestampMs <= elapsed) {
            const f = frameQueue.shift();
            try {
              const livekitFrame = new import_rtc_node.VideoFrame(
                f.buffer,
                f.width,
                f.height,
                import_rtc_node.VideoBufferType.I420
              );
              source.captureFrame(livekitFrame);
            } catch (captureErr) {
              if (VOICE_DEBUG)
                this.audioDebug("captureFrame error", { error: String(captureErr) });
              this.emit(
                "error",
                captureErr instanceof Error ? captureErr : new Error(String(captureErr))
              );
            }
          }
        }, FRAME_INTERVAL_MS);
        setImmediate(() => {
          if (!this._playingVideo) return;
          file.start();
        });
        if (videoUrl && audioSource && audioTrack) {
          const runAudioFfmpeg = async () => {
            if (!this._playingVideo || cleanupCalled || !audioSource) return;
            const audioProc = (0, import_node_child_process.spawn)(
              "ffmpeg",
              [
                "-loglevel",
                "warning",
                "-re",
                "-i",
                videoUrl,
                "-vn",
                "-c:a",
                "libopus",
                "-f",
                "webm",
                ...loop ? ["-stream_loop", "-1"] : [],
                "pipe:1"
              ],
              { stdio: ["ignore", "pipe", "pipe"] }
            );
            audioFfmpegProc = audioProc;
            const demuxer = new import_prism_media2.opus.WebmDemuxer();
            if (audioProc.stdout) audioProc.stdout.pipe(demuxer);
            const decoder2 = new import_opus_decoder.OpusDecoder({ sampleRate: SAMPLE_RATE, channels: CHANNELS2 });
            await decoder2.ready;
            let sampleBuffer = new Int16Array(0);
            let opusBuffer = new Uint8Array(0);
            let processing = false;
            const opusFrameQueue = [];
            const processOneOpusFrame = async (frame) => {
              if (frame.length < 2 || !audioSource || !this._playingVideo) return;
              try {
                const result = decoder2.decodeFrame(frame);
                if (!result?.channelData?.[0]?.length) return;
                const int16 = floatToInt16(result.channelData[0]);
                const newBuffer = new Int16Array(sampleBuffer.length + int16.length);
                newBuffer.set(sampleBuffer);
                newBuffer.set(int16, sampleBuffer.length);
                sampleBuffer = newBuffer;
                while (sampleBuffer.length >= FRAME_SAMPLES && this._playingVideo && audioSource) {
                  const rawSamples = sampleBuffer.subarray(0, FRAME_SAMPLES);
                  sampleBuffer = sampleBuffer.subarray(FRAME_SAMPLES).slice();
                  const outSamples = applyVolumeToInt16(rawSamples, this._volume);
                  const audioFrame = new import_rtc_node.AudioFrame(
                    outSamples,
                    SAMPLE_RATE,
                    CHANNELS2,
                    FRAME_SAMPLES
                  );
                  if (audioSource.queuedDuration > 500) await audioSource.waitForPlayout();
                  await audioSource.captureFrame(audioFrame);
                }
              } catch {
              }
            };
            const drainQueue = async () => {
              if (processing || opusFrameQueue.length === 0) return;
              processing = true;
              while (opusFrameQueue.length > 0 && this._playingVideo && audioSource) {
                const f = opusFrameQueue.shift();
                await processOneOpusFrame(f);
              }
              processing = false;
            };
            demuxer.on("data", (chunk) => {
              if (!this._playingVideo) return;
              opusBuffer = new Uint8Array(concatUint8Arrays(opusBuffer, new Uint8Array(chunk)));
              while (opusBuffer.length > 0) {
                const parsed = parseOpusPacketBoundaries(opusBuffer);
                if (!parsed) break;
                opusBuffer = new Uint8Array(opusBuffer.subarray(parsed.consumed));
                for (const frame of parsed.frames) opusFrameQueue.push(frame);
              }
              drainQueue().catch(() => {
              });
            });
            audioProc.on("exit", (code) => {
              if (audioFfmpegProc === audioProc) audioFfmpegProc = null;
              if (loop && this._playingVideo && !cleanupCalled && (code === 0 || code === null)) {
                setImmediate(() => runAudioFfmpeg());
              }
            });
          };
          runAudioFfmpeg().catch(
            (e) => this.audioDebug("audio ffmpeg error", { error: String(e) })
          );
        }
        this.emit("requestVoiceStateSync", {
          self_stream: sourceOption === "screenshare",
          self_video: sourceOption === "camera"
        });
      }).catch((err) => {
        this._playingVideo = false;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    };
    arrayBuffer.fileStart = 0;
    file.appendBuffer(arrayBuffer);
    file.flush();
  }
  /**
   * FFmpeg-based video playback. Bypasses node-webcodecs to avoid libc++abi crashes on macOS.
   * Requires ffmpeg and ffprobe in PATH. URL input only.
   */
  async playVideoFFmpeg(url, options) {
    const sourceOption = options?.source ?? "camera";
    const loop = options?.loop ?? true;
    let width = 640;
    let height = 480;
    let hasAudio = false;
    try {
      const exec = (0, import_node_util.promisify)(import_node_child_process.execFile);
      const { stdout } = await exec(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_streams",
          "-show_entries",
          "stream=codec_type,width,height",
          "-of",
          "json",
          url
        ],
        { encoding: "utf8", timeout: 1e4 }
      );
      const parsed = JSON.parse(stdout);
      const streams = parsed?.streams ?? [];
      for (const s of streams) {
        if (s.codec_type === "video" && s.width != null && s.height != null) {
          width = s.width;
          height = s.height;
          break;
        }
      }
      for (const s of streams) {
        if (s.codec_type === "audio") {
          hasAudio = true;
          break;
        }
      }
    } catch (probeErr) {
      this.emit(
        "error",
        new Error(
          `ffprobe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`
        )
      );
      return;
    }
    let maxFps = options?.maxFramerate ?? 60;
    const res = options?.resolution;
    if (res === "480p") {
      width = 854;
      height = 480;
      maxFps = 60;
    } else if (res === "720p") {
      width = 1280;
      height = 720;
      maxFps = 60;
    } else if (res === "1080p") {
      width = 1920;
      height = 1080;
      maxFps = 60;
    } else if (res === "1440p") {
      width = 2560;
      height = 1440;
      maxFps = 60;
    } else if (res === "4k") {
      width = 3840;
      height = 2160;
      maxFps = 60;
    } else if (options?.width != null && options?.height != null) {
      width = options.width;
      height = options.height;
    }
    const source = new import_rtc_node.VideoSource(width, height);
    this.videoSource = source;
    const track = import_rtc_node.LocalVideoTrack.createVideoTrack("video", source);
    this.videoTrack = track;
    const publishOptions = new import_rtc_node.TrackPublishOptions({
      source: sourceOption === "screenshare" ? import_rtc_node.TrackSource.SOURCE_SCREENSHARE : import_rtc_node.TrackSource.SOURCE_CAMERA,
      videoEncoding: {
        maxBitrate: BigInt(options?.videoBitrate ?? 25e5),
        maxFramerate: maxFps
      }
    });
    const participant = this.room?.localParticipant;
    if (!participant) return;
    try {
      await participant.publishTrack(track, publishOptions);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let audioSource = null;
    let audioReady = false;
    if (hasAudio) {
      const src = new import_rtc_node.AudioSource(SAMPLE_RATE, CHANNELS2);
      audioSource = src;
      this.audioSource = src;
      const track2 = import_rtc_node.LocalAudioTrack.createAudioTrack("audio", src);
      this.audioTrack = track2;
      try {
        await participant.publishTrack(
          track2,
          new import_rtc_node.TrackPublishOptions({ source: import_rtc_node.TrackSource.SOURCE_MICROPHONE })
        );
        audioReady = true;
      } catch {
        track2.close().catch(() => {
        });
        this.audioTrack = null;
        this.audioSource = null;
      }
    } else {
      this.audioSource = null;
      this.audioTrack = null;
    }
    this._playingVideo = true;
    this.emit("requestVoiceStateSync", {
      self_stream: sourceOption === "screenshare",
      self_video: sourceOption === "camera"
    });
    const frameSize = Math.ceil(width * height * 3 / 2);
    const FRAME_INTERVAL_MS = Math.round(1e3 / maxFps);
    let pacingTimeout = null;
    let ffmpegProc = null;
    let cleanupCalled = false;
    const doCleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      this._videoCleanup = null;
      this._playingVideo = false;
      if (pacingTimeout !== null) {
        clearTimeout(pacingTimeout);
        pacingTimeout = null;
      }
      if (ffmpegProc && !ffmpegProc.killed) {
        ffmpegProc.kill("SIGKILL");
        ffmpegProc = null;
      }
      this.emit("requestVoiceStateSync", { self_stream: false, self_video: false });
      this.currentVideoStream = null;
      if (this.audioTrack) {
        this.audioTrack.close().catch(() => {
        });
        this.audioTrack = null;
      }
      if (this.audioSource) {
        this.audioSource.close().catch(() => {
        });
        this.audioSource = null;
      }
      if (this.videoTrack) {
        this.videoTrack.close().catch(() => {
        });
        this.videoTrack = null;
      }
      if (this.videoSource) {
        this.videoSource.close().catch(() => {
        });
        this.videoSource = null;
      }
    };
    this._videoCleanup = () => doCleanup();
    const frameBuffer = [];
    let frameBufferBytes = 0;
    const MAX_QUEUED_FRAMES = 60;
    const FRAME_DURATION_US = BigInt(Math.round(1e6 / maxFps));
    let frameIndex = 0n;
    const pushFramesFromBuffer = () => {
      if (!this._playingVideo || !source || cleanupCalled) return;
      if (frameBufferBytes < frameSize) return;
      if (frameBufferBytes > frameSize * MAX_QUEUED_FRAMES) {
        const framesToDrop = Math.floor((frameBufferBytes - frameSize * 2) / frameSize);
        let toDropBytes = framesToDrop * frameSize;
        while (toDropBytes > 0 && frameBuffer.length > 0) {
          const c = frameBuffer[0];
          if (c.length <= toDropBytes) {
            toDropBytes -= c.length;
            frameBufferBytes -= c.length;
            frameBuffer.shift();
          } else {
            frameBuffer[0] = c.subarray(toDropBytes);
            frameBufferBytes -= toDropBytes;
            toDropBytes = 0;
          }
        }
      }
      let remaining = frameSize;
      const parts = [];
      while (remaining > 0 && frameBuffer.length > 0) {
        const c = frameBuffer[0];
        const take = Math.min(remaining, c.length);
        parts.push(c.subarray(0, take));
        remaining -= take;
        if (take >= c.length) {
          frameBuffer.shift();
        } else {
          frameBuffer[0] = c.subarray(take);
        }
      }
      frameBufferBytes -= frameSize;
      const frameData = Buffer.concat(parts, frameSize);
      if (frameData.length !== frameSize) return;
      try {
        const frame = new import_rtc_node.VideoFrame(
          new Uint8Array(frameData.buffer, frameData.byteOffset, frameSize),
          width,
          height,
          import_rtc_node.VideoBufferType.I420
        );
        const timestampUs = frameIndex * FRAME_DURATION_US;
        frameIndex += 1n;
        source.captureFrame(frame, timestampUs);
      } catch (e) {
        if (VOICE_DEBUG) this.audioDebug("captureFrame error", { error: String(e) });
      }
    };
    const scheduleNextPacing = () => {
      if (!this._playingVideo || cleanupCalled) return;
      pushFramesFromBuffer();
      pacingTimeout = setTimeout(scheduleNextPacing, FRAME_INTERVAL_MS);
    };
    scheduleNextPacing();
    const runFFmpeg = async () => {
      const ffmpegArgs = [
        "-loglevel",
        "warning",
        "-re",
        ...loop ? ["-stream_loop", "-1"] : [],
        "-i",
        url,
        "-map",
        "0:v",
        "-vf",
        `scale=${width}:${height}`,
        "-r",
        String(maxFps),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "pipe:1",
        ...hasAudio ? ["-map", "0:a", "-c:a", "libopus", "-f", "webm", "-vn", "pipe:3"] : []
      ];
      const stdioOpts = hasAudio ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
      const proc = (0, import_node_child_process.spawn)("ffmpeg", ffmpegArgs, { stdio: stdioOpts });
      ffmpegProc = proc;
      this.currentVideoStream = {
        destroy: () => {
          if (proc && !proc.killed) proc.kill("SIGKILL");
        }
      };
      const stdout = proc.stdout;
      const stderr = proc.stderr;
      if (stdout) {
        stdout.on("data", (chunk) => {
          if (!this._playingVideo || cleanupCalled) return;
          frameBuffer.push(chunk);
          frameBufferBytes += chunk.length;
        });
      }
      if (stderr) {
        stderr.on("data", (data) => {
          const line = data.toString().trim();
          if (line && VOICE_DEBUG) this.audioDebug("ffmpeg stderr", { line: line.slice(0, 200) });
        });
      }
      if (hasAudio && audioReady && audioSource && proc.stdio[3]) {
        const audioPipe = proc.stdio[3];
        const demuxer = new import_prism_media2.opus.WebmDemuxer();
        audioPipe.pipe(demuxer);
        const decoder = new import_opus_decoder.OpusDecoder({ sampleRate: SAMPLE_RATE, channels: CHANNELS2 });
        await decoder.ready;
        let sampleBuffer = new Int16Array(0);
        let opusBuffer = new Uint8Array(0);
        let processing = false;
        const opusFrameQueue = [];
        const processOneOpusFrame = async (frame) => {
          if (frame.length < 2 || !audioSource || !this._playingVideo) return;
          try {
            const result = decoder.decodeFrame(frame);
            if (!result?.channelData?.[0]?.length) return;
            const int16 = floatToInt16(result.channelData[0]);
            const newBuffer = new Int16Array(sampleBuffer.length + int16.length);
            newBuffer.set(sampleBuffer);
            newBuffer.set(int16, sampleBuffer.length);
            sampleBuffer = newBuffer;
            while (sampleBuffer.length >= FRAME_SAMPLES && this._playingVideo && audioSource) {
              const rawSamples = sampleBuffer.subarray(0, FRAME_SAMPLES);
              sampleBuffer = sampleBuffer.subarray(FRAME_SAMPLES).slice();
              const outSamples = applyVolumeToInt16(rawSamples, this._volume);
              const audioFrame = new import_rtc_node.AudioFrame(outSamples, SAMPLE_RATE, CHANNELS2, FRAME_SAMPLES);
              if (audioSource.queuedDuration > 500) await audioSource.waitForPlayout();
              await audioSource.captureFrame(audioFrame);
            }
          } catch {
          }
        };
        const drainQueue = async () => {
          if (processing || opusFrameQueue.length === 0) return;
          processing = true;
          while (opusFrameQueue.length > 0 && this._playingVideo && audioSource) {
            const f = opusFrameQueue.shift();
            await processOneOpusFrame(f);
          }
          processing = false;
        };
        demuxer.on("data", (chunk) => {
          if (!this._playingVideo) return;
          opusBuffer = new Uint8Array(concatUint8Arrays(opusBuffer, new Uint8Array(chunk)));
          while (opusBuffer.length > 0) {
            const parsed = parseOpusPacketBoundaries(opusBuffer);
            if (!parsed) break;
            opusBuffer = new Uint8Array(opusBuffer.subarray(parsed.consumed));
            for (const frame of parsed.frames) opusFrameQueue.push(frame);
          }
          drainQueue().catch(() => {
          });
        });
      }
      proc.on("error", (err) => {
        this.emit("error", err);
        doCleanup();
      });
      proc.on("exit", (code) => {
        ffmpegProc = null;
        if (cleanupCalled || !this._playingVideo) return;
        if (loop && (code === 0 || code === null)) {
          frameBuffer.length = 0;
          frameBufferBytes = 0;
          frameIndex = 0n;
          setImmediate(() => runFFmpeg());
        } else {
          doCleanup();
        }
      });
    };
    runFFmpeg().catch((e) => this.audioDebug("ffmpeg error", { error: String(e) }));
  }
  /**
   * Play audio from a WebM/Opus URL or readable stream. Publishes to the LiveKit room as an audio track.
   *
   * @param urlOrStream - Audio source: HTTP(S) URL to a WebM/Opus file, or a Node.js ReadableStream
   * @emits error - On fetch failure or decode errors
   */
  async play(urlOrStream) {
    this.stop();
    if (!this.room || !this.room.isConnected) {
      this.emit("error", new Error("LiveKit: not connected"));
      return;
    }
    let inputStream;
    if (typeof urlOrStream === "string") {
      try {
        const response = await fetch(urlOrStream);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error("No response body");
        inputStream = import_node_stream2.Readable.fromWeb(response.body);
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
        return;
      }
    } else {
      inputStream = urlOrStream;
    }
    const source = new import_rtc_node.AudioSource(SAMPLE_RATE, CHANNELS2);
    this.audioSource = source;
    const track = import_rtc_node.LocalAudioTrack.createAudioTrack("audio", source);
    this.audioTrack = track;
    const options = new import_rtc_node.TrackPublishOptions();
    options.source = import_rtc_node.TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant.publishTrack(track, options);
    const demuxer = new import_prism_media2.opus.WebmDemuxer();
    inputStream.pipe(demuxer);
    this.currentStream = demuxer;
    const decoder = new import_opus_decoder.OpusDecoder({ sampleRate: SAMPLE_RATE, channels: CHANNELS2 });
    await decoder.ready;
    this._playing = true;
    let sampleBuffer = new Int16Array(0);
    let opusBuffer = new Uint8Array(0);
    let _streamEnded = false;
    let framesCaptured = 0;
    const processOneOpusFrame = async (frame) => {
      if (frame.length < 2) return;
      try {
        const result = decoder.decodeFrame(frame);
        if (!result?.channelData?.[0]?.length) return;
        const int16 = floatToInt16(result.channelData[0]);
        const newBuffer = new Int16Array(sampleBuffer.length + int16.length);
        newBuffer.set(sampleBuffer);
        newBuffer.set(int16, sampleBuffer.length);
        sampleBuffer = newBuffer;
        while (sampleBuffer.length >= FRAME_SAMPLES && this._playing && source) {
          const rawSamples = sampleBuffer.subarray(0, FRAME_SAMPLES);
          sampleBuffer = sampleBuffer.subarray(FRAME_SAMPLES).slice();
          const outSamples = applyVolumeToInt16(rawSamples, this._volume);
          const audioFrame = new import_rtc_node.AudioFrame(outSamples, SAMPLE_RATE, CHANNELS2, FRAME_SAMPLES);
          if (source.queuedDuration > 500) {
            await source.waitForPlayout();
          }
          await source.captureFrame(audioFrame);
          framesCaptured++;
        }
      } catch (err) {
        if (VOICE_DEBUG) this.audioDebug("decode error", { error: String(err) });
      }
    };
    let firstChunk = true;
    let processing = false;
    const opusFrameQueue = [];
    const drainOpusQueue = async () => {
      if (processing || opusFrameQueue.length === 0) return;
      processing = true;
      while (opusFrameQueue.length > 0 && this._playing && source) {
        const frame = opusFrameQueue.shift();
        await processOneOpusFrame(frame);
      }
      processing = false;
    };
    demuxer.on("data", (chunk) => {
      if (!this._playing) return;
      if (firstChunk) {
        this.audioDebug("first audio chunk received", { size: chunk.length });
        firstChunk = false;
      }
      opusBuffer = concatUint8Arrays(opusBuffer, new Uint8Array(chunk));
      while (opusBuffer.length > 0) {
        const parsed = parseOpusPacketBoundaries(opusBuffer);
        if (!parsed) break;
        opusBuffer = opusBuffer.slice(parsed.consumed);
        for (const frame of parsed.frames) {
          opusFrameQueue.push(frame);
        }
      }
      drainOpusQueue().catch((e) => this.audioDebug("drainOpusQueue error", { error: String(e) }));
    });
    demuxer.on("error", (err) => {
      this.audioDebug("demuxer error", { error: err.message });
      this._playing = false;
      this.currentStream = null;
      this.emit("error", err);
    });
    demuxer.on("end", async () => {
      _streamEnded = true;
      this.audioDebug("stream ended", { framesCaptured });
      while (processing || opusFrameQueue.length > 0) {
        await drainOpusQueue();
        await new Promise((r) => setImmediate(r));
      }
      while (sampleBuffer.length >= FRAME_SAMPLES && this._playing && source) {
        const rawSamples = sampleBuffer.subarray(0, FRAME_SAMPLES);
        sampleBuffer = sampleBuffer.subarray(FRAME_SAMPLES).slice();
        const outSamples = applyVolumeToInt16(rawSamples, this._volume);
        const audioFrame = new import_rtc_node.AudioFrame(outSamples, SAMPLE_RATE, CHANNELS2, FRAME_SAMPLES);
        await source.captureFrame(audioFrame);
        framesCaptured++;
      }
      if (sampleBuffer.length > 0 && this._playing && source) {
        const padded = new Int16Array(FRAME_SAMPLES);
        padded.set(sampleBuffer);
        const outSamples = applyVolumeToInt16(padded, this._volume);
        const audioFrame = new import_rtc_node.AudioFrame(outSamples, SAMPLE_RATE, CHANNELS2, FRAME_SAMPLES);
        await source.captureFrame(audioFrame);
        framesCaptured++;
      }
      this.audioDebug("playback complete", { framesCaptured });
      this._playing = false;
      this.currentStream = null;
      if (this.audioTrack) {
        await this.audioTrack.close();
        this.audioTrack = null;
      }
      if (this.audioSource) {
        await this.audioSource.close();
        this.audioSource = null;
      }
    });
  }
  /**
   * Stop video playback and unpublish the video track from the LiveKit room.
   * Safe to call even when no video is playing.
   */
  _videoCleaning = false;
  stopVideo() {
    if (this._videoCleaning) return;
    if (this._videoCleanup) {
      this._videoCleaning = true;
      try {
        this._videoCleanup();
      } finally {
        this._videoCleaning = false;
      }
      this._videoCleanup = null;
      return;
    }
    this._playingVideo = false;
    this.emit("requestVoiceStateSync", { self_stream: false, self_video: false });
    if (this.currentVideoStream?.destroy) this.currentVideoStream.destroy();
    this.currentVideoStream = null;
    if (this.videoTrack) {
      this.videoTrack.close().catch(() => {
      });
      this.videoTrack = null;
    }
    if (this.videoSource) {
      this.videoSource.close().catch(() => {
      });
      this.videoSource = null;
    }
  }
  /** Stop playback and clear both audio and video tracks. */
  stop() {
    this._playing = false;
    this.stopVideo();
    this.clearReceiveSubscriptions();
    if (this.currentStream?.destroy) this.currentStream.destroy();
    this.currentStream = null;
    if (this.audioTrack) {
      this.audioTrack.close().catch(() => {
      });
      this.audioTrack = null;
    }
    if (this.audioSource) {
      this.audioSource.close().catch(() => {
      });
      this.audioSource = null;
    }
  }
  /** Disconnect from the LiveKit room and stop all playback. */
  disconnect() {
    this._destroyed = true;
    this.stop();
    if (this.room) {
      this.room.disconnect().catch(() => {
      });
      this.room = null;
    }
    this.lastServerEndpoint = null;
    this.lastServerToken = null;
    this.emit("disconnect");
  }
  /** Disconnect from the room and remove all event listeners. */
  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }
};

// src/VoiceManager.ts
var import_collection = require("@fluxerjs/collection");
var VoiceManager = class extends import_events3.EventEmitter {
  client;
  /** channel_id -> connection (Fluxer multi-channel: allows multiple connections per guild) */
  connections = new import_collection.Collection();
  /** channel_id -> connection_id (from VoiceServerUpdate; required for voice state updates) */
  connectionIds = /* @__PURE__ */ new Map();
  /** guild_id -> user_id -> channel_id */
  voiceStates = /* @__PURE__ */ new Map();
  /** channel_id -> pending join */
  pending = /* @__PURE__ */ new Map();
  shardId;
  constructor(client, options = {}) {
    super();
    this.client = client;
    this.shardId = options.shardId ?? 0;
    this.client.on(
      import_core.Events.VoiceStateUpdate,
      (data) => this.handleVoiceStateUpdate(data)
    );
    this.client.on(
      import_core.Events.VoiceServerUpdate,
      (data) => this.handleVoiceServerUpdate(data)
    );
    this.client.on(
      import_core.Events.VoiceStatesSync,
      (data) => this.handleVoiceStatesSync(data)
    );
  }
  handleVoiceStatesSync(data) {
    let guildMap = this.voiceStates.get(data.guildId);
    if (!guildMap) {
      guildMap = /* @__PURE__ */ new Map();
      this.voiceStates.set(data.guildId, guildMap);
    }
    for (const vs of data.voiceStates) {
      guildMap.set(vs.user_id, vs.channel_id);
    }
  }
  /**
   * Get the voice channel ID the user is currently in, or null if not in voice.
   * @param guildId - Guild ID to look up
   * @param userId - User ID to look up
   */
  getVoiceChannelId(guildId, userId) {
    const guildMap = this.voiceStates.get(guildId);
    if (!guildMap) return null;
    return guildMap.get(userId) ?? null;
  }
  /**
   * List participant user IDs currently in a specific voice channel.
   */
  listParticipantsInChannel(guildId, channelId) {
    const guildMap = this.voiceStates.get(guildId);
    if (!guildMap) return [];
    const participants = [];
    for (const [userId, voiceChannelId] of guildMap.entries()) {
      if (voiceChannelId === channelId) participants.push(userId);
    }
    return participants;
  }
  /**
   * Subscribe to inbound audio for all known participants currently in a voice channel.
   * Only supported for LiveKit connections.
   */
  subscribeChannelParticipants(channelId, opts) {
    const conn = this.connections.get(channelId);
    if (!(conn instanceof LiveKitRtcConnection)) return [];
    const guildId = conn.channel.guildId;
    const participants = this.listParticipantsInChannel(guildId, channelId).filter(
      (participantId) => participantId !== this.client.user?.id
    );
    return participants.map(
      (participantId) => conn.subscribeParticipantAudio(participantId, opts)
    );
  }
  handleVoiceStateUpdate(data) {
    const guildId = data.guild_id ?? "";
    if (!guildId) return;
    this.client.emit?.(
      "debug",
      `[VoiceManager] VoiceStateUpdate guild=${guildId} user=${data.user_id} channel=${data.channel_id ?? "null"} (bot=${this.client.user?.id})`
    );
    let guildMap = this.voiceStates.get(guildId);
    if (!guildMap) {
      guildMap = /* @__PURE__ */ new Map();
      this.voiceStates.set(guildId, guildMap);
    }
    guildMap.set(data.user_id, data.channel_id);
    const channelKey = data.channel_id ?? guildId;
    const pendingByChannel = this.pending.get(channelKey);
    const pendingByGuild = this.pending.get(guildId);
    const pending = pendingByChannel ?? pendingByGuild;
    const isBot = String(data.user_id) === String(this.client.user?.id);
    if (isBot && data.connection_id) {
      this.storeConnectionId(channelKey, data.connection_id);
    }
    if (pending && isBot) {
      this.client.emit?.(
        "debug",
        `[VoiceManager] VoiceStateUpdate for bot - completing pending channel ${channelKey}`
      );
      pending.state = data;
      this.tryCompletePending(pendingByChannel ? channelKey : guildId, pending);
    }
  }
  handleVoiceServerUpdate(data) {
    const guildId = data.guild_id;
    let pending = this.pending.get(guildId);
    if (!pending) {
      for (const [, p] of this.pending) {
        if (p.channel?.guildId === guildId) {
          pending = p;
          break;
        }
      }
    }
    if (pending) {
      const channelKey = pending.channel?.id ?? guildId;
      const hasToken = !!(data.token && data.token.length > 0);
      this.client.emit?.(
        "debug",
        `[VoiceManager] VoiceServerUpdate guild=${guildId} channel=${channelKey} endpoint=${data.endpoint ?? "null"} token=${hasToken ? "yes" : "NO"}`
      );
      pending.server = data;
      this.tryCompletePending(channelKey, pending);
      return;
    }
    const userId = this.client.user?.id;
    if (!userId) {
      this.client.emit?.(
        "debug",
        "[VoiceManager] Client user not available. Ensure the client is logged in."
      );
      return;
    }
    let conn;
    for (const [, c] of this.connections) {
      if (c?.channel?.guildId === guildId) {
        conn = c;
        break;
      }
    }
    if (!conn) return;
    if (!data.endpoint || !data.token) {
      this.client.emit?.(
        "debug",
        `[VoiceManager] Voice server endpoint null for guild ${guildId}; disconnecting`
      );
      conn.destroy();
      this.connections.delete(conn.channel.id);
      return;
    }
    if (!isLiveKitEndpoint(data.endpoint, data.token)) return;
    if (conn instanceof LiveKitRtcConnection && conn.isSameServer(data.endpoint, data.token)) {
      return;
    }
    const channel = conn.channel;
    this.client.emit?.(
      "debug",
      `[VoiceManager] Voice server migration for guild ${guildId} channel ${channel.id}; reconnecting`
    );
    conn.destroy();
    this.connections.delete(channel.id);
    this.connectionIds.delete(channel.id);
    this.storeConnectionId(channel.id, data.connection_id);
    const ConnClass = LiveKitRtcConnection;
    const newConn = new ConnClass(this.client, channel, userId);
    this.registerConnection(channel.id, newConn);
    const state = {
      guild_id: guildId,
      channel_id: channel.id,
      user_id: userId,
      session_id: ""
    };
    newConn.connect(data, state).catch((e) => {
      this.connections.delete(channel.id);
      newConn.emit("error", e instanceof Error ? e : new Error(String(e)));
    });
  }
  storeConnectionId(channelId, connectionId) {
    const id = connectionId != null ? String(connectionId) : null;
    if (id) this.connectionIds.set(channelId, id);
    else this.connectionIds.delete(channelId);
  }
  registerConnection(channelId, conn) {
    const cid = conn.channel?.id ?? channelId;
    this.connections.set(cid, conn);
    conn.once("disconnect", () => {
      this.connections.delete(cid);
      this.connectionIds.delete(cid);
    });
    conn.on("requestVoiceStateSync", (p) => {
      this.updateVoiceState(cid, p);
      if (p.self_stream) {
        this.uploadStreamPreview(cid, conn).catch(
          (e) => this.client.emit?.("debug", `[VoiceManager] Stream preview upload failed: ${String(e)}`)
        );
      }
    });
  }
  /** Upload a placeholder stream preview so the preview URL returns 200 instead of 404. */
  async uploadStreamPreview(channelId, conn) {
    const cid = conn.channel?.id ?? channelId;
    const connectionId = this.connectionIds.get(cid);
    if (!connectionId) return;
    const streamKey = `${conn.channel.guildId}:${conn.channel.id}:${connectionId}`;
    const route = import_types.Routes.streamPreview(streamKey);
    const body = { channel_id: conn.channel.id, thumbnail, content_type: "image/png" };
    await this.client.rest.post(route, { body, auth: true });
    this.client.emit?.("debug", `[VoiceManager] Uploaded stream preview for ${streamKey}`);
  }
  tryCompletePending(channelId, pending) {
    if (!pending?.server) return;
    const useLiveKit = isLiveKitEndpoint(pending.server.endpoint, pending.server.token);
    const hasState = !!pending.state;
    if (!useLiveKit && !hasState) return;
    if (useLiveKit && !hasState) {
      this.client.emit?.(
        "debug",
        `[VoiceManager] Proceeding with VoiceServerUpdate only (LiveKit does not require VoiceStateUpdate)`
      );
    }
    const userId = this.client.user?.id;
    if (!userId) {
      this.client.emit?.(
        "debug",
        "[VoiceManager] Client user not available. Ensure the client is logged in."
      );
      return;
    }
    const guildId = pending.channel?.guildId ?? "";
    const state = pending.state ?? {
      guild_id: guildId,
      channel_id: pending.channel.id,
      user_id: userId,
      session_id: ""
    };
    this.storeConnectionId(
      channelId,
      pending.server.connection_id ?? state.connection_id
    );
    this.pending.delete(channelId);
    const ConnClass = useLiveKit ? LiveKitRtcConnection : VoiceConnection;
    const conn = new ConnClass(this.client, pending.channel, userId);
    this.registerConnection(channelId, conn);
    conn.connect(pending.server, state).then(
      () => pending.resolve(conn),
      (e) => pending.reject(e)
    );
  }
  /**
   * Join a voice channel. Resolves when the connection is ready.
   * Supports multiple connections per guild (Fluxer multi-channel).
   * @param channel - The voice channel to join
   * @returns The voice connection (LiveKitRtcConnection when Fluxer uses LiveKit)
   */
  async join(channel) {
    const channelId = channel.id;
    const existing = this.connections.get(channelId);
    if (existing) {
      const isReusable = existing instanceof LiveKitRtcConnection ? existing.isConnected() : true;
      if (isReusable) return existing;
      existing.destroy();
      this.connections.delete(channelId);
    }
    return new Promise((resolve, reject) => {
      this.client.emit?.(
        "debug",
        `[VoiceManager] Requesting voice join guild=${channel.guildId} channel=${channelId}`
      );
      const timeout = setTimeout(() => {
        if (this.pending.has(channelId)) {
          this.pending.delete(channelId);
          reject(
            new Error(
              "Voice connection timeout. Ensure the server has voice enabled and the bot has Connect permissions. The gateway must send VoiceServerUpdate and VoiceStateUpdate in response."
            )
          );
        }
      }, 2e4);
      this.pending.set(channelId, {
        channel,
        resolve: (c) => {
          clearTimeout(timeout);
          resolve(c);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        }
      });
      this.client.sendToGateway(this.shardId, {
        op: import_types.GatewayOpcodes.VoiceStateUpdate,
        d: {
          guild_id: channel.guildId,
          channel_id: channel.id,
          self_mute: false,
          self_deaf: false
        }
      });
    });
  }
  /**
   * Leave all voice channels in a guild.
   * With multi-channel support, disconnects from every channel in the guild.
   * @param guildId - Guild ID to leave
   */
  leave(guildId) {
    const toLeave = [];
    for (const [cid, c] of this.connections) {
      if (c?.channel?.guildId === guildId) toLeave.push({ channelId: cid, conn: c });
    }
    for (const { channelId, conn } of toLeave) {
      conn.destroy();
      this.connections.delete(channelId);
      this.connectionIds.delete(channelId);
    }
    if (toLeave.length > 0) {
      this.client.sendToGateway(this.shardId, {
        op: import_types.GatewayOpcodes.VoiceStateUpdate,
        d: {
          guild_id: guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false
        }
      });
    }
  }
  /**
   * Leave a specific voice channel by channel ID.
   * @param channelId - Channel ID to leave
   */
  leaveChannel(channelId) {
    const conn = this.connections.get(channelId);
    if (conn) {
      const guildId = conn.channel?.guildId;
      conn.destroy();
      this.connections.delete(channelId);
      this.connectionIds.delete(channelId);
      if (guildId) {
        this.client.sendToGateway(this.shardId, {
          op: import_types.GatewayOpcodes.VoiceStateUpdate,
          d: {
            guild_id: guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false
          }
        });
      }
    }
  }
  /**
   * Get the active voice connection for a channel or guild.
   * @param channelOrGuildId - Channel ID (primary) or guild ID (returns first connection in that guild)
   */
  getConnection(channelOrGuildId) {
    const byChannel = this.connections.get(channelOrGuildId);
    if (byChannel) return byChannel;
    for (const [, c] of this.connections) {
      if (c?.channel?.guildId === channelOrGuildId) return c;
    }
    return void 0;
  }
  /**
   * Update voice state (e.g. self_stream, self_video) while in a channel.
   * Sends a VoiceStateUpdate to the gateway so the server and clients see the change.
   * Requires connection_id (from VoiceServerUpdate); without it, the gateway would treat
   * the update as a new join and trigger a new VoiceServerUpdate, causing connection loops.
   * @param channelId - Channel ID (connection key)
   * @param partial - Partial voice state to update (self_stream, self_video, self_mute, self_deaf)
   */
  updateVoiceState(channelId, partial) {
    const conn = this.connections.get(channelId);
    if (!conn) return;
    const connectionId = this.connectionIds.get(channelId);
    const guildId = conn.channel?.guildId;
    if (!connectionId) {
      this.client.emit?.(
        "debug",
        `[VoiceManager] Skipping voice state sync: no connection_id for channel ${channelId}`
      );
      return;
    }
    this.client.sendToGateway(this.shardId, {
      op: import_types.GatewayOpcodes.VoiceStateUpdate,
      d: {
        guild_id: guildId ?? "",
        channel_id: conn.channel.id,
        connection_id: connectionId,
        self_mute: partial.self_mute ?? false,
        self_deaf: partial.self_deaf ?? false,
        self_video: partial.self_video ?? false,
        self_stream: partial.self_stream ?? false
      }
    });
  }
};

// src/index.ts
async function joinVoiceChannel(client, channel, options) {
  const manager = getVoiceManager(client, options);
  return manager.join(channel);
}
var voiceManagers = /* @__PURE__ */ new WeakMap();
function getVoiceManager(client, options) {
  let manager = voiceManagers.get(client);
  if (!manager) {
    manager = new VoiceManager(client, options);
    voiceManagers.set(client, manager);
  }
  return manager;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LiveKitRtcConnection,
  VoiceConnection,
  VoiceManager,
  getVoiceManager,
  joinVoiceChannel
});
