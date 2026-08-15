/**
 * file_read Tool Handler - reads a text file with optional line range.
 *
 * Read-only operation, no approval required (same level as `cat`/`type`
 * which are on the exec readonly whitelist).
 *
 * Safety caps:
 *   - Files larger than 64MB are refused
 *   - Binary files (NUL byte in first 8KB) are refused
 *   - At most 4000 lines / 512KB of content per call (truncated flag set)
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { FileReadErrorResult, FileReadOkResult } from '../../types/tools.js';
import type { FileReadInput } from './schema.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LINES = 4000;
const MAX_CONTENT_BYTES = 512 * 1024;
const SNIFF_BYTES = 8192;

function errorResult(filePath: string, error: string) {
  const body: FileReadErrorResult = { status: 'error', path: filePath, error };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

/** Sniffs the first chunk for NUL bytes — a reliable binary tell. */
async function looksBinary(filePath: string): Promise<boolean> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

export async function fileReadHandler(args: FileReadInput) {
  const { path: filePath, startLine = 1, endLine } = args;

  logger.info('file_read tool called', { path: filePath, startLine, endLine });

  const abs = path.resolve(filePath);

  let fileStat;
  try {
    fileStat = await stat(abs);
  } catch {
    return errorResult(abs, 'Path does not exist or is not accessible');
  }
  if (!fileStat.isFile()) {
    return errorResult(abs, 'Path is not a regular file');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    return errorResult(abs, `File too large (${fileStat.size} bytes, cap is ${MAX_FILE_BYTES})`);
  }

  try {
    if (await looksBinary(abs)) {
      return errorResult(abs, 'File appears to be binary (NUL byte in first 8KB), refusing to read as text');
    }
  } catch (err) {
    return errorResult(abs, err instanceof Error ? err.message : String(err));
  }

  if (endLine !== undefined && endLine < startLine) {
    return errorResult(abs, `endLine (${endLine}) is smaller than startLine (${startLine})`);
  }

  try {
    const fh = await open(abs, 'r');
    let text: string;
    try {
      text = await fh.readFile('utf8');
    } finally {
      await fh.close();
    }

    const allLines = text.split(/\r?\n/);
    const totalLines = allLines.length;

    const from = Math.min(startLine, totalLines);
    const requestedEnd = endLine ?? totalLines;
    let to = Math.min(requestedEnd, totalLines);

    // Cap line count
    let truncated = false;
    if (to - from + 1 > MAX_LINES) {
      to = from + MAX_LINES - 1;
      truncated = true;
    }

    let content = allLines.slice(from - 1, to).join('\n');

    // Cap byte size
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      content = Buffer.from(content, 'utf8').subarray(0, MAX_CONTENT_BYTES).toString('utf8');
      truncated = true;
    }

    const body: FileReadOkResult = {
      status: 'ok',
      path: abs,
      totalLines,
      startLine: from,
      endLine: to,
      truncated,
      content,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  } catch (err) {
    return errorResult(abs, err instanceof Error ? err.message : String(err));
  }
}
