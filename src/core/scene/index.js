/**
 * Scene Protocol — Public API
 *
 * Declarative Agent-driven UI system.

 *
 * Usage:
 * const { globalSceneStore, registerSceneTools } = require('./scene');
 *
 * // Register tools with central registry
 * const { registry } = require('../../tools/registry');
 * registerSceneTools(registry);
 *
 * // Get/set surfaces
 * globalSceneStore.upsertSurface('sidebar', { kind: 'panel', data: { ... } });
 * const snapshot = globalSceneStore.getSnapshot();
 */

const { SceneStore, getSceneStore, VALID_INTENTS } = require('./scene-store');
const { registerSceneTools, sceneTools } = require('./scene-tools');
const { SceneServer, createSceneServer, getSceneServer, PROTOCOL_MODES } = require('./scene-server');
const { SceneBridge, getSceneBridge } = require('./scene-bridge');
const { registerSceneKindTools } = require('./scene-kinds-tool');
const v1 = require('./scene-protocol-v1');

/**
 * Global SceneStore singleton.
 * Use this directly for server-side scene manipulation.
 */
const globalSceneStore = getSceneStore();

module.exports = {
 // Store
 SceneStore,
 globalSceneStore,
 getSceneStore,
 VALID_INTENTS,

 // Tools
 registerSceneTools,
 sceneTools,
 registerSceneKindTools,

 // WebSocket Server
 SceneServer,
 createSceneServer,
 getSceneServer,
 PROTOCOL_MODES,

 // v1 Protocol
 sceneProtocolV1: v1,

 // Bridge (auto-projection of business data → scene)
 SceneBridge,
 getSceneBridge,
};
