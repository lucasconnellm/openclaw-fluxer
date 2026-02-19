import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { fluxerPlugin } from "./src/channel.js";
import { setFluxerRuntime } from "./src/runtime.js";

const plugin = {
  id: "fluxer",
  name: "Fluxer",
  description: "Fluxer channel plugin powered by @fluxerjs/core",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFluxerRuntime(api.runtime);
    api.registerChannel({ plugin: fluxerPlugin });
  },
};

export default plugin;
