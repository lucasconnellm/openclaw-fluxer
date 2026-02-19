import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setFluxerRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getFluxerRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Fluxer runtime not initialized");
  }
  return runtime;
}
