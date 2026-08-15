/**
 * file_delete Tool Handler - queues a delete for user confirmation.
 *
 * Write operations NEVER execute inline (security.md level 2, del/rm):
 * this handler mints a confirmToken; the confirmed delete runs through
 * the confirm tool.
 *
 * Guard rails evaluated at execution time (in confirm):
 *   - refuses to delete filesystem roots (C:\, /, D:\ ...)
 *   - non-empty directories require recursive: true
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import path from 'node:path';
import { createPending } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
export async function fileDeleteHandler(args) {
    const { path: target, recursive = false } = args;
    logger.info('file_delete tool called', { path: target, recursive });
    const abs = path.resolve(target);
    // Never queue a root delete, even for confirmation
    if (abs === path.parse(abs).root) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        status: 'error',
                        path: abs,
                        error: 'Refusing to delete a filesystem root',
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
    createPending({
        operation: { kind: 'file_delete', path: abs, recursive },
        reason: `file_delete ${recursive ? '(recursive) ' : ''}${abs}`,
    });
    const body = {
        status: 'confirmation_required',
        operation: 'file_delete',
        reason: `Delete ${abs}${recursive ? ' recursively (all contents included)' : ''}. Nothing has been deleted yet.`,
        executed: false,
        expiresInSec: 300,
        note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
}
//# sourceMappingURL=handler.js.map