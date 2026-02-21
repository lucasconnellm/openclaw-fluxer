import { describe, expect, it, vi } from "vitest";
import {
  DraftPreviewController,
  resolveStreamingPreviewConfig,
  type FluxerStreamingPreviewConfig,
} from "./streaming-preview.js";

describe("resolveStreamingPreviewConfig", () => {
  it("returns safe defaults", () => {
    expect(resolveStreamingPreviewConfig(undefined)).toEqual({
      enabled: false,
      mode: "partial",
      minCharsDelta: 40,
      idleMs: 700,
      maxEdits: 40,
    });
  });

  it("normalizes explicit settings", () => {
    expect(
      resolveStreamingPreviewConfig({
        enabled: true,
        mode: "block",
        minCharsDelta: 5.9,
        idleMs: 200,
        maxEdits: 3,
      }),
    ).toEqual({
      enabled: true,
      mode: "block",
      minCharsDelta: 5,
      idleMs: 200,
      maxEdits: 3,
    });
  });
});

describe("DraftPreviewController", () => {
  function makeController(cfg: Partial<FluxerStreamingPreviewConfig> = {}) {
    const send = vi.fn(async (text: string) => ({ messageId: `m-${text.length}`, chatId: "c-1" }));
    const edit = vi.fn(async () => undefined);
    const log = vi.fn();
    let now = 1_000;

    const controller = new DraftPreviewController(
      {
        enabled: true,
        mode: "partial",
        minCharsDelta: 20,
        idleMs: 500,
        maxEdits: 5,
        ...cfg,
      },
      {
        send,
        edit,
        log,
        now: () => now,
      },
    );

    return {
      controller,
      send,
      edit,
      log,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  it("sends first preview message and coalesces tiny updates", async () => {
    const { controller, send, edit, setNow } = makeController({ minCharsDelta: 10, idleMs: 800 });

    await expect(controller.update("hello world")).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);

    setNow(1_200);
    await expect(controller.update("hello world!")).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(0);

    setNow(2_000);
    await expect(controller.update("hello world! now this changed enough")).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("finalizes by editing the existing preview", async () => {
    const { controller, edit } = makeController();

    await controller.update("draft 1");
    await expect(controller.finalize("final answer")).resolves.toBe(true);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith({
      chatId: "c-1",
      messageId: "m-7",
      text: "final answer",
    });
  });

  it("disables after max edits and reports fallback", async () => {
    const { controller, edit, log, setNow } = makeController({
      minCharsDelta: 0,
      idleMs: 0,
      maxEdits: 2,
    });

    await controller.update("one");
    setNow(2_000);
    await controller.update("two");
    setNow(3_000);

    await expect(controller.update("three")).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
