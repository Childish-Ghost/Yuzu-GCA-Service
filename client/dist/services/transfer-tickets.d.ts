/**
 * Transfer Tickets - one-shot download authorizations for cross-device
 * file transfer (C-007, data plane).
 *
 * Control plane (Gateway/AI) only ever sees the URL + token; file bytes
 * flow device → device directly. Tickets are:
 *   - single-use (consumed on first successful download)
 *   - short-lived (default 5 min)
 *   - bound to exactly one file path
 */
export interface TransferTicket {
    token: string;
    path: string;
    size: number;
    createdAt: number;
    expiresAt: number;
}
export declare function mintTicket(filePath: string, size: number, ttlMs?: number): TransferTicket;
/**
 * Validates and CONSUMES a ticket (single-use). Returns the ticket when
 * valid, null when unknown/expired/already used.
 */
export declare function consumeTicket(token: string): TransferTicket | null;
/** Visible for testing. */
export declare function clearTickets(): void;
