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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface TransferTicket {
  token: string;
  path: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const tickets = new Map<string, TransferTicket>();

export function mintTicket(filePath: string, size: number, ttlMs: number = DEFAULT_TTL_MS): TransferTicket {
  const ticket: TransferTicket = {
    token: randomBytes(24).toString('base64url'),
    path: filePath,
    size,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  tickets.set(ticket.token, ticket);
  logger.info('Transfer ticket minted', { path: filePath, size, ttlMs });
  return ticket;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Validates and CONSUMES a ticket (single-use). Returns the ticket when
 * valid, null when unknown/expired/already used.
 */
export function consumeTicket(token: string): TransferTicket | null {
  for (const [key, ticket] of tickets) {
    if (!safeEqual(key, token)) continue;
    tickets.delete(key);
    if (Date.now() > ticket.expiresAt) {
      logger.warn('Transfer ticket used after expiry', { path: ticket.path });
      return null;
    }
    return ticket;
  }
  return null;
}

/** Visible for testing. */
export function clearTickets(): void {
  tickets.clear();
}
