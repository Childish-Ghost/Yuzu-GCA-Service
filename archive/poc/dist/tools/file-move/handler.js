/**
 * file_move Tool Handler - queues a move/rename for user confirmation.
 *
 * Write operations NEVER execute inline (security.md level 2): this handler
 * mints a confirmToken; the confirmed move runs through the confirm tool.
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
import path from 'node:path';
import { createPending } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
export async function fileMoveHandler(args) {
    const { source, dest } = args;
    logger.info('file_move tool called', { source, dest });
    const absSource = path.resolve(source);
    const absDest = path.resolve(dest);
    createPending({
        operation: { kind: 'file_move', source: absSource, dest: absDest },
        reason: `file_move ${absSource} -> ${absDest}`,
    });
    const body = {
        status: 'confirmation_required',
        operation: 'file_move',
        reason: `Move ${absSource} to ${absDest}. Nothing has been moved yet.`,
        executed: false,
        expiresInSec: 300,
        note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
}
//# sourceMappingURL=handler.js.map