/**
 * Agent adapter interface — the pluggable base for AI backends.
 *
 * GCA is not built for one platform: OpenClaw, Hermes, or any future backend
 * plugs in behind this interface. Each backend uses its most natural
 * transport (OpenClaw → Gateway WS, Hermes → HTTP+SSE OpenAI-compatible API).
 * Nothing above this layer touches backend protocols.
 */
export {};
//# sourceMappingURL=adapter.js.map