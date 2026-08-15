/**
 * Clipboard Sync Watcher (R-003) - device-to-device clipboard sync (text + images).
 *
 * Runs as a background service alongside the MCP server:
 *   - Polls local clipboard every 2s; on change → push to relay
 *   - Polls relay for remote clipboard every 2s; on newer → set local
 *
 * No AI involvement — pure device-to-device, like Apple Universal Clipboard.
 * Config: GCA_CLIPBOARD_SYNC=1 to enable (default: on when relay is configured)
 */
export declare function startClipboardSync(): void;
export declare function stopClipboardSync(): void;
