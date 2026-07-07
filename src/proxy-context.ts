import { abortBridge, ClientToolBridgeRegistry } from "./client-tools/bridge.js";
import type { AppConfig } from "./config.js";
import { SessionStore } from "./session-store.js";

export interface ProxyContext {
  readonly config: AppConfig;
  readonly sessions: SessionStore;
  readonly toolBridges: ClientToolBridgeRegistry;
}

export function createProxyContext(config: AppConfig): ProxyContext {
  const toolBridges = new ClientToolBridgeRegistry();
  const sessions = new SessionStore({
    // A disposed agent kills its transport; tear down any run parked on it
    // instead of leaving a zombie bridge until the tool-result timeout.
    onAgentDisposed: (agentId) => {
      const bridge = toolBridges.take(agentId);
      if (bridge) void abortBridge(bridge);
    },
  });
  return {
    config,
    sessions,
    toolBridges,
  };
}
