/* The on-surface comment bridge that the Surface proxy inlines into every HTML page it serves. It lives in the shared,
 * framework-free @opencode-ai/surface-bridge module (packages/surface-bridge; protocol and privacy rules in its
 * PROTOCOL.md) so other hosts consume the same controller; this re-export keeps es-app's import paths stable. */
export { BRIDGE_SOURCE as SURFACE_BRIDGE, injectBridge } from "../surface-bridge/src/index.js"
