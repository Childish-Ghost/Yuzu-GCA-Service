/**
 * OpenClaw Gateway WS adapter — zero-dependency client for the Gateway
 * WebSocket protocol (v4).
 *
 * Implemented from the official protocol docs + gateway-client reference
 * (frame shapes, connect.challenge → connect → hello-ok handshake, payload v3
 * device signature). Uses Node's built-in WebSocket (Node 22+), no npm deps.
 *
 * Connection path: backend operator client on loopback with shared gateway
 * token — the officially supported path where `device` may be omitted. If the
 * gateway requires device pairing, we fall back to a persisted ed25519 device
 * identity (payload v3 signature, auto-created on first use).
 */
import { randomUUID, generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const PROTOCOL_VERSION = 4;
const SCOPE_ADMIN = 'operator.admin';
const SCOPE_READ = 'operator.read';
const SCOPE_WRITE = 'operator.write';
const SCOPE_APPROVALS = 'operator.approvals';
const REQUEST_TIMEOUT_MS = 30_000;
const CHAT_WAIT_TIMEOUT_MS = 90_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KEY_FILE = path.join(homedir(), '.gca-server', 'agent-key.json');
export class OpenClawWsAdapter {
    name = 'openclaw';
    ws = null;
    ready = false;
    connecting = null;
    pending = new Map();
    nextId = 1;
    reconnectTimer = null;
    reconnectDelay = RECONNECT_MIN_MS;
    stopped = false;
    lastActivityAt = 0;
    tickIntervalMs = 30_000;
    tickWatch = null;
    device = null;
    deviceToken = null;
    listeners = new Set();
    opts;
    constructor(options) {
        this.opts = { clientName: 'gateway-client', clientVersion: '0.5.0', ...options };
        try {
            this.device = this.loadDeviceIdentity();
        }
        catch {
            this.device = null;
        }
    }
    get connected() {
        return this.ready && this.ws?.readyState === WebSocket.OPEN;
    }
    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    close() {
        this.stopped = true;
        this.clearReconnect();
        this.ws?.close();
        this.ws = null;
        this.ready = false;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('connection closed'));
        }
        this.pending.clear();
    }
    /** Connect + handshake if not ready. Serialized; safe to call concurrently. */
    ensureConnected() {
        if (this.connected)
            return Promise.resolve();
        if (this.connecting)
            return this.connecting;
        this.connecting = this.connect().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }
    /**
     * Send a message to the AI and return the full reply.
     *
     * Event-driven: collects `chat` events (deltaText accumulation) for the run,
     * resolves on the `final` event's message. Timeout returns accumulated text.
     * (agent.wait only returns a run-status snapshot, not the reply text.)
     */
    async chat(message, sessionKey) {
        await this.ensureConnected();
        // Collect chat events for all runs while this turn is in flight.
        // Keyed by runId so concurrent chats (different sessionKeys) don't collide.
        const events = new Map();
        const unsubscribe = this.onEvent((event, payload) => {
            if (event !== 'chat')
                return;
            const p = payload;
            if (!p || typeof p.runId !== 'string')
                return;
            const entry = events.get(p.runId) ?? { text: '' };
            if (p.state === 'delta' && typeof p.deltaText === 'string')
                entry.text += p.deltaText;
            if (p.state === 'final')
                entry.final = p;
            events.set(p.runId, entry);
        });
        try {
            const sendRes = (await this.request('chat.send', {
                sessionKey,
                message,
                idempotencyKey: randomUUID(),
            }));
            const runId = typeof sendRes?.runId === 'string' ? sendRes.runId
                : typeof sendRes?.id === 'string' ? sendRes.id
                    : undefined;
            if (!runId)
                throw new Error(`chat.send returned no runId: ${JSON.stringify(sendRes ?? null).slice(0, 200)}`);
            const deadline = Date.now() + CHAT_WAIT_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const entry = events.get(runId);
                if (entry?.final !== undefined) {
                    const finalMessage = entry.final.message;
                    const text = extractAssistantText(finalMessage) || entry.text;
                    return { text, sessionKey, runId };
                }
                await sleep(200);
            }
            return { text: events.get(runId)?.text ?? '', sessionKey, runId };
        }
        finally {
            unsubscribe();
            events.clear();
        }
    }
    // --- internals ---
    async connect() {
        if (this.stopped)
            return;
        this.clearReconnect();
        const url = this.opts.url;
        const ws = new WebSocket(url);
        let challenge = null;
        let sentConnect = false;
        const fail = (err) => {
            try {
                ws.close();
            }
            catch { /* noop */ }
            this.ready = false;
            this.scheduleReconnect();
            throw err;
        };
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`gateway connect timeout (${url})`)), REQUEST_TIMEOUT_MS);
            ws.onopen = () => {
                this.lastActivityAt = Date.now();
                // Wait for the gateway's connect.challenge before sending connect.
            };
            ws.onmessage = (ev) => {
                this.lastActivityAt = Date.now();
                let frame;
                try {
                    frame = JSON.parse(String(ev.data));
                }
                catch {
                    return; // ignore malformed frames
                }
                if (frame.type === 'event' && frame.event === 'connect.challenge') {
                    challenge = frame.payload ?? null;
                    if (!challenge?.nonce) {
                        clearTimeout(timer);
                        reject(new Error('connect.challenge missing nonce'));
                        return;
                    }
                    // buildConnectRequest already returns a JSON string — send as-is
                    ws.send(this.buildConnectRequest(challenge));
                    sentConnect = true;
                    return;
                }
                if (frame.type === 'res' && frame.id !== undefined) {
                    const p = this.pending.get(String(frame.id));
                    if (p) {
                        clearTimeout(p.timer);
                        this.pending.delete(String(frame.id));
                        if (frame.ok && frame.payload !== undefined)
                            p.resolve(frame.payload);
                        else
                            p.reject(new Error(formatGatewayError(frame)));
                    }
                    // Handshake response (before the connection is ready)
                    if (!this.ready && frame.ok && frame.payload?.type === 'hello-ok') {
                        clearTimeout(timer);
                        this.onHelloOk(frame.payload);
                        resolve();
                    }
                    else if (!this.ready && !frame.ok) {
                        clearTimeout(timer);
                        reject(new Error(`gateway connect rejected: ${formatGatewayError(frame)}`));
                    }
                    return;
                }
                if (frame.type === 'event') {
                    this.dispatchEvent(frame.event, frame.payload);
                }
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error(`gateway WebSocket error (${url})`));
            };
            ws.onclose = () => {
                clearTimeout(timer);
                if (!this.ready)
                    reject(new Error(`gateway closed before hello-ok (${url})`));
                else
                    this.scheduleReconnect();
            };
        }).catch((err) => {
            this.ws = null;
            this.ready = false;
            throw err;
        });
        this.ws = ws;
    }
    buildConnectRequest(challenge) {
        const scopes = [SCOPE_READ, SCOPE_WRITE, SCOPE_APPROVALS, SCOPE_ADMIN];
        const auth = {};
        if (this.opts.token)
            auth.token = this.opts.token;
        if (this.deviceToken)
            auth.deviceToken = this.deviceToken;
        return JSON.stringify({
            type: 'req',
            id: `connect-${this.nextId++}`,
            method: 'connect',
            params: {
                minProtocol: PROTOCOL_VERSION,
                maxProtocol: PROTOCOL_VERSION,
                client: {
                    id: this.opts.clientName,
                    version: this.opts.clientVersion,
                    platform: process.platform,
                    mode: 'backend',
                },
                caps: [],
                role: 'operator',
                scopes,
                auth,
                locale: 'zh-CN',
                userAgent: `gca-server/${this.opts.clientVersion}`,
                // With a shared gateway token on loopback, backend clients may omit
                // `device` (official trusted-path exemption). Device pairing is only
                // used as the no-token fallback.
                ...(this.device && !this.opts.token ? { device: this.buildDeviceParams(challenge, scopes) } : {}),
            },
        });
    }
    /** device identity + payload v3 signature (only when a device identity exists) */
    buildDeviceParams(challenge, scopes) {
        const device = this.device;
        const payload = [
            'v3',
            device.id,
            this.opts.clientName,
            'backend',
            'operator',
            scopes.join(','),
            String(challenge.ts),
            this.opts.token ?? '',
            challenge.nonce,
            normalizeForAuth(process.platform),
            '',
        ].join('|');
        // EdDSA signs the internal hash — crypto.sign(null, …) is the supported form
        const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), device.privateKeyPem).toString('base64url');
        return {
            id: device.id,
            publicKey: publicKeyRawBase64Url(device.publicKeyPem),
            signature,
            signedAt: challenge.ts,
            nonce: challenge.nonce,
        };
    }
    onHelloOk(hello) {
        this.ready = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.tickIntervalMs = typeof hello.policy?.tickIntervalMs === 'number' ? hello.policy.tickIntervalMs : 30_000;
        // Persist device token for future reconnects
        if (hello.auth?.deviceToken) {
            this.deviceToken = hello.auth.deviceToken;
            // S13：私钥+设备 token 明文落盘——权限收紧 0600（POSIX；Windows 记入遗留）
            try {
                writeFileSync(KEY_FILE, JSON.stringify({ ...this.device, deviceToken: hello.auth.deviceToken }), 'utf8');
                chmodSync(KEY_FILE, 0o600);
            }
            catch { /* non-fatal */ }
        }
        this.startTickWatch();
        console.log(new Date().toISOString(), `[agent] openclaw connected: server ${hello.server?.version ?? '?'} connId ${hello.server?.connId?.slice(0, 8) ?? '?'} scopes ${(hello.auth?.scopes ?? []).join(',')}`);
    }
    /** Server sends `tick` every tickIntervalMs — treat silence > 3x as a dead connection. */
    startTickWatch() {
        if (this.tickWatch)
            clearInterval(this.tickWatch);
        this.tickWatch = setInterval(() => {
            if (this.stopped)
                return;
            if (this.ready && Date.now() - this.lastActivityAt > this.tickIntervalMs * 3) {
                console.warn(new Date().toISOString(), '[agent] gateway tick silence — reconnecting');
                this.ready = false;
                try {
                    this.ws?.close();
                }
                catch { /* noop */ }
                this.ws = null;
                this.scheduleReconnect();
            }
        }, this.tickIntervalMs);
    }
    dispatchEvent(event, payload) {
        if (event === 'tick')
            this.lastActivityAt = Date.now();
        for (const l of this.listeners) {
            try {
                l(event, payload);
            }
            catch { /* listener errors are non-fatal */ }
        }
    }
    request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const id = String(this.nextId++);
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`gateway request timeout for ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws?.send(JSON.stringify({ type: 'req', id, method, params }));
        });
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        console.warn(new Date().toISOString(), `[agent] gateway disconnected — reconnect in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureConnected().catch((err) => {
                console.error(new Date().toISOString(), `[agent] reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, delay);
    }
    clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    loadDeviceIdentity() {
        if (!existsSync(KEY_FILE)) {
            const identity = createDeviceIdentity();
            try {
                mkdirSync(path.dirname(KEY_FILE), { recursive: true });
                writeFileSync(KEY_FILE, JSON.stringify(identity), 'utf8');
                chmodSync(KEY_FILE, 0o600); // S13：ed25519 私钥权限收紧
            }
            catch {
                return null;
            }
            return identity;
        }
        try {
            const data = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
            if (data.deviceToken)
                this.deviceToken = data.deviceToken;
            if (data.id && data.publicKeyPem && data.privateKeyPem) {
                return { id: data.id, publicKeyPem: data.publicKeyPem, privateKeyPem: data.privateKeyPem };
            }
        }
        catch { /* corrupt — recreate below */ }
        return createDeviceIdentity();
    }
}
// --- helpers ---
function normalizeForAuth(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return '';
    return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
function createDeviceIdentity() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const raw = publicKey.export({ type: 'spki', format: 'der' });
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return { id, publicKeyPem, privateKeyPem };
}
function publicKeyRawBase64Url(pem) {
    const base64 = pem
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s+/g, '');
    return Buffer.from(base64, 'base64').toString('base64url');
}
function formatGatewayError(frame) {
    const err = frame.error ?? {};
    return `${err.code ?? 'ERROR'}: ${err.message ?? 'unknown'}${err.details?.reason ? ` (${err.details.reason})` : ''}`;
}
/** Extract assistant text from a final message (tolerant of shape drift). */
function extractAssistantText(snap) {
    if (typeof snap === 'string')
        return snap;
    if (!snap || typeof snap !== 'object')
        return '';
    const obj = snap;
    if (typeof obj.text === 'string')
        return obj.text;
    const message = obj.message;
    if (typeof message?.text === 'string')
        return message.text;
    if (typeof message === 'string')
        return message;
    const result = obj.result;
    if (typeof result?.text === 'string')
        return result.text;
    if (typeof obj.error === 'string')
        return `error: ${obj.error}`;
    return '';
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=openclaw.js.map