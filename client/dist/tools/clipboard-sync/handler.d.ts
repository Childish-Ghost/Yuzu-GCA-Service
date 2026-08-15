/**
 * clipboard_sync Tool Handler (R-003) - read/write the system clipboard.
 *
 * Both actions are privacy-sensitive (clipboard may contain passwords),
 * so they go through the standard confirmation flow.
 */
import type { ClipboardSyncInput } from './schema.js';
export declare function clipboardSyncHandler(args: ClipboardSyncInput): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: undefined;
}>;
/** Executes the confirmed clipboard action. */
export declare function executeClipboardSync(action: 'get' | 'set', text: string): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
