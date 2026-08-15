/**
 * file_list Tool Handler - lists directory contents with optional glob filter.
 *
 * Read-only operation, no approval required (same level as `dir`/`ls`
 * which are on the exec readonly whitelist).
 *
 * Safety caps:
 *   - Max 2000 entries returned (truncated flag set when hit)
 *   - Max recursion depth 8
 *   - Unreadable directories are skipped, never fatal
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
export const FILE_LIST_MAX_ENTRIES = 2000;
export const FILE_LIST_MAX_DEPTH = 8;
/**
 * Converts a shell-style wildcard pattern (* and ?) into an anchored RegExp.
 * Matching is case-insensitive on Windows, case-sensitive elsewhere.
 */
export function wildcardToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    const flags = process.platform === 'win32' ? 'i' : '';
    return new RegExp(`^${regexStr}$`, flags);
}
async function walk(rootAbs, dirAbs, depth, recursive, matcher, entries, state) {
    if (state.truncated)
        return;
    if (depth > FILE_LIST_MAX_DEPTH) {
        state.truncated = true;
        return;
    }
    let dirents;
    try {
        dirents = await readdir(dirAbs, { withFileTypes: true });
    }
    catch {
        // Unreadable directory (permissions, race with deletion) — skip silently.
        return;
    }
    for (const d of dirents) {
        if (entries.length >= FILE_LIST_MAX_ENTRIES) {
            state.truncated = true;
            return;
        }
        const type = d.isDirectory()
            ? 'directory'
            : d.isFile()
                ? 'file'
                : 'other';
        // Pattern filters which entries are LISTED, but never blocks recursion —
        // otherwise "*.pdf" would never find PDFs inside non-matching directories.
        if (!matcher || matcher.test(d.name)) {
            const abs = path.join(dirAbs, d.name);
            let size;
            let mtime;
            try {
                const s = await stat(abs);
                size = type === 'file' ? s.size : undefined;
                mtime = s.mtime.toISOString();
            }
            catch {
                // Entry vanished or unreadable — list it without metadata.
            }
            entries.push({
                name: d.name,
                path: path.relative(rootAbs, abs) || d.name,
                type,
                size,
                mtime,
            });
        }
        if (type === 'directory' && recursive) {
            await walk(rootAbs, path.join(dirAbs, d.name), depth + 1, recursive, matcher, entries, state);
            if (state.truncated)
                return;
        }
    }
}
export async function fileListHandler(args) {
    const { path: dirPath, pattern, recursive = false } = args;
    logger.info('file_list tool called', { path: dirPath, pattern, recursive });
    const rootAbs = path.resolve(dirPath);
    // Verify target exists and is a directory
    let rootStat;
    try {
        rootStat = await stat(rootAbs);
    }
    catch {
        const body = {
            status: 'error',
            path: rootAbs,
            error: 'Path does not exist or is not accessible',
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            isError: true,
        };
    }
    if (!rootStat.isDirectory()) {
        const body = {
            status: 'error',
            path: rootAbs,
            error: 'Path is not a directory',
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            isError: true,
        };
    }
    const matcher = pattern ? wildcardToRegex(pattern) : null;
    const entries = [];
    const state = { truncated: false };
    await walk(rootAbs, rootAbs, 0, recursive, matcher, entries, state);
    // Directories first, then alphabetical by relative path
    entries.sort((a, b) => {
        if (a.type !== b.type)
            return a.type === 'directory' ? -1 : 1;
        return a.path.localeCompare(b.path);
    });
    const body = {
        status: 'ok',
        path: rootAbs,
        pattern: pattern ?? null,
        recursive,
        truncated: state.truncated,
        totalEntries: entries.length,
        entries,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
}
//# sourceMappingURL=handler.js.map