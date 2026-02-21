export type FluxerStreamingPreviewMode = "partial" | "block";

export type FluxerStreamingPreviewConfig = {
  enabled: boolean;
  mode: FluxerStreamingPreviewMode;
  minCharsDelta: number;
  idleMs: number;
  maxEdits: number;
};

const DEFAULT_STREAMING_CONFIG: FluxerStreamingPreviewConfig = {
  enabled: false,
  mode: "partial",
  minCharsDelta: 40,
  idleMs: 700,
  maxEdits: 40,
};

export function resolveStreamingPreviewConfig(raw: unknown): FluxerStreamingPreviewConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STREAMING_CONFIG };
  }

  const value = raw as {
    enabled?: unknown;
    mode?: unknown;
    minCharsDelta?: unknown;
    idleMs?: unknown;
    maxEdits?: unknown;
  };

  const mode: FluxerStreamingPreviewMode = value.mode === "block" ? "block" : "partial";
  const enabled = value.enabled === true;

  const minCharsDelta =
    typeof value.minCharsDelta === "number" && Number.isFinite(value.minCharsDelta)
      ? Math.max(0, Math.floor(value.minCharsDelta))
      : DEFAULT_STREAMING_CONFIG.minCharsDelta;

  const idleMs =
    typeof value.idleMs === "number" && Number.isFinite(value.idleMs)
      ? Math.max(0, Math.floor(value.idleMs))
      : DEFAULT_STREAMING_CONFIG.idleMs;

  const maxEdits =
    typeof value.maxEdits === "number" && Number.isFinite(value.maxEdits)
      ? Math.max(1, Math.floor(value.maxEdits))
      : DEFAULT_STREAMING_CONFIG.maxEdits;

  return {
    enabled,
    mode,
    minCharsDelta,
    idleMs,
    maxEdits,
  };
}

export type DraftPreviewDeps = {
  send: (text: string) => Promise<{ messageId: string; chatId: string }>;
  edit: (params: { chatId: string; messageId: string; text: string }) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
};

export class DraftPreviewController {
  private readonly cfg: FluxerStreamingPreviewConfig;
  private readonly deps: DraftPreviewDeps;
  private messageId: string | null = null;
  private chatId: string | null = null;
  private lastText = "";
  private lastEditAt = 0;
  private edits = 0;
  private disabled = false;

  constructor(cfg: FluxerStreamingPreviewConfig, deps: DraftPreviewDeps) {
    this.cfg = cfg;
    this.deps = deps;
  }

  isEnabled(): boolean {
    return this.cfg.enabled && !this.disabled;
  }

  shouldHandle(kind: "partial" | "block"): boolean {
    return this.isEnabled() && this.cfg.mode === kind;
  }

  hasPreviewMessage(): boolean {
    return Boolean(this.messageId && this.chatId);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private disable(reason: string): void {
    this.disabled = true;
    this.deps.log?.(`draft preview disabled: ${reason}`);
  }

  private normalizeText(text: string | undefined): string {
    return (text ?? "").trim();
  }

  private shouldCoalesce(nextText: string, nowMs: number): boolean {
    if (!this.lastText) return false;
    const delta = Math.abs(nextText.length - this.lastText.length);
    const sinceLastEdit = nowMs - this.lastEditAt;
    return delta < this.cfg.minCharsDelta && sinceLastEdit < this.cfg.idleMs;
  }

  async update(nextTextRaw: string | undefined): Promise<boolean> {
    if (!this.isEnabled()) return false;

    const nextText = this.normalizeText(nextTextRaw);
    if (!nextText) return false;

    const nowMs = this.now();

    if (!this.messageId || !this.chatId) {
      try {
        const created = await this.deps.send(nextText);
        this.messageId = created.messageId;
        this.chatId = created.chatId;
        this.lastText = nextText;
        this.lastEditAt = nowMs;
        this.edits = 1;
        return true;
      } catch (error) {
        this.disable(`initial send failed: ${String(error)}`);
        return false;
      }
    }

    if (nextText === this.lastText) return true;
    if (this.shouldCoalesce(nextText, nowMs)) return true;

    if (this.edits >= this.cfg.maxEdits) {
      this.disable(`reached maxEdits=${this.cfg.maxEdits}`);
      return false;
    }

    try {
      await this.deps.edit({
        chatId: this.chatId,
        messageId: this.messageId,
        text: nextText,
      });
      this.lastText = nextText;
      this.lastEditAt = nowMs;
      this.edits += 1;
      return true;
    } catch (error) {
      this.disable(`edit failed: ${String(error)}`);
      return false;
    }
  }

  async finalize(finalTextRaw: string | undefined): Promise<boolean> {
    if (!this.hasPreviewMessage()) return false;

    const finalText = this.normalizeText(finalTextRaw);
    if (!finalText) return true;
    if (finalText === this.lastText) return true;

    if (!this.messageId || !this.chatId) return false;

    try {
      await this.deps.edit({
        chatId: this.chatId,
        messageId: this.messageId,
        text: finalText,
      });
      this.lastText = finalText;
      this.lastEditAt = this.now();
      this.edits += 1;
      return true;
    } catch (error) {
      this.disable(`finalize edit failed: ${String(error)}`);
      return false;
    }
  }
}
