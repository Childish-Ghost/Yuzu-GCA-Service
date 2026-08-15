/**
 * Approval Relay client (device side of GAP-v2).
 *
 * Delivers approval pushes to the owner via the gap-relay service on the
 * gateway VM (Feishu + WeChat, device-originated — the AI never sees or
 * alters the op description, and never learns the nonce).
 *
 * The push is OUT OF BAND: it bypasses the AI context entirely. The nonce
 * inside it is how the owner proves "I read and approved THIS operation".
 */
/**
 * Sends an approval push. Returns true when the relay accepted and
 * delivered to at least one channel; false on any failure (caller falls
 * back to the next delivery mode in the chain).
 */
export declare function submitApprovalPush(opDetail: string, nonce: string): Promise<boolean>;
