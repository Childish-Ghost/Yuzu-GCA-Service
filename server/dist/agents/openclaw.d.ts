import type { AgentAdapter, AgentChatResult } from './adapter.js';
interface OpenClawAdapterOptions {
    url: string;
    token?: string;
    clientName?: string;
    clientVersion?: string;
}
export declare class OpenClawWsAdapter implements AgentAdapter {
    readonly name = "openclaw";
    private ws;
    private ready;
    private connecting;
    private pending;
    private nextId;
    private reconnectTimer;
    private reconnectDelay;
    private stopped;
    private lastActivityAt;
    private tickIntervalMs;
    private tickWatch;
    private device;
    private deviceToken;
    private listeners;
    private readonly opts;
    constructor(options: OpenClawAdapterOptions);
    get connected(): boolean;
    onEvent(listener: (event: string, payload: unknown) => void): () => void;
    close(): void;
    /** Connect + handshake if not ready. Serialized; safe to call concurrently. */
    ensureConnected(): Promise<void>;
    /**
     * Send a message to the AI and return the full reply.
     *
     * Event-driven: collects `chat` events (deltaText accumulation) for the run,
     * resolves on the `final` event's message. Timeout returns accumulated text.
     * (agent.wait only returns a run-status snapshot, not the reply text.)
     */
    chat(message: string, sessionKey: string): Promise<AgentChatResult>;
    private connect;
    private buildConnectRequest;
    /** device identity + payload v3 signature (only when a device identity exists) */
    private buildDeviceParams;
    private onHelloOk;
    /** Server sends `tick` every tickIntervalMs — treat silence > 3x as a dead connection. */
    private startTickWatch;
    private dispatchEvent;
    private request;
    private scheduleReconnect;
    private clearReconnect;
    private loadDeviceIdentity;
}
export {};
