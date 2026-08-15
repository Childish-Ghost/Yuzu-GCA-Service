/**
 * Agent adapter interface — the pluggable base for AI backends.
 *
 * GCA is not built for one platform: OpenClaw, Hermes, or any future backend
 * plugs in behind this interface. Each backend uses its most natural
 * transport (OpenClaw → Gateway WS, Hermes → HTTP+SSE OpenAI-compatible API).
 * Nothing above this layer touches backend protocols.
 */

export interface AgentChatResult {
  /** Full assistant reply text */
  text: string;
  /** Session key used (keeps conversation context across turns) */
  sessionKey: string;
  /** Gateway run id when available */
  runId?: string;
}

export interface AgentAdapter {
  readonly name: string;
  /** True when the backend connection is ready (handshake done) */
  readonly connected: boolean;

  /** Ensure the backend connection is ready (connect + handshake, reconnect if needed) */
  ensureConnected(): Promise<void>;

  /** Send a message and return the assistant's full reply. Non-streaming v1. */
  chat(message: string, sessionKey: string): Promise<AgentChatResult>;

  /** Register a listener for backend events (chat deltas, approvals…). Returns unsubscribe. */
  onEvent?(listener: (event: string, payload: unknown) => void): () => void;

  /** Tear down the connection (used at shutdown) */
  close(): void;
}
