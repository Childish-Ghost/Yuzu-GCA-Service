/**
 * Transfer Fetch - the download half of cross-device transfer.
 *
 * Shared by the file_fetch tool (ticket URLs execute immediately) and the
 * confirm dispatcher (foreign URLs run after confirmation).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Matches the one-shot transfer URL shape produced by file_serve. */
export function isTransferTicketUrl(url: string): boolean {
  return /^http:\/\/[\w.:-]+\/transfer\/[\w-]{20,}$/i.test(url);
}

export interface FetchOutcome {
  bytes: number;
  sizeMatches: boolean;
}

export async function downloadFile(url: string, targetPath: string): Promise<FetchOutcome> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`Source returned HTTP ${res.status} (ticket invalid, expired, or already used)`);
  }
  const expected = Number(res.headers.get('content-length') ?? -1);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expected >= 0 && buf.length !== expected) {
    throw new Error(`Size mismatch: expected ${expected} bytes, got ${buf.length} (transfer truncated)`);
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buf);
  return { bytes: buf.length, sizeMatches: expected < 0 || buf.length === expected };
}
