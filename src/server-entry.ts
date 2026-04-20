import type { PluginModule } from "@opencode-ai/plugin"

import { MissionControlPlugin } from "./plugin.js"

export const server = MissionControlPlugin

const module: PluginModule & { id: string } = {
  id: "opencode-mission-control",
  server: MissionControlPlugin,
}

export default module
