/**
 * Approval Service - enforces the three-level command approval policy.
 *
 * Level 1 (readonly):  Auto-approve and execute immediately.
 * Level 2 (write):     Require explicit confirmation.
 *                       POC: returns a "confirmation required" response.
 *                       Production: integrate with chat channel or UI prompt.
 * Level 3 (dangerous): Block immediately, log to security audit trail.
 */
import { classifyCommand } from './classifier.js';
import { logger } from '../utils/logger.js';
/**
 * Evaluates a command against the three-level approval policy.
 *
 * @param command - The raw command string to evaluate
 * @returns ApprovalResult with the decision and explanation
 */
export function evaluateCommand(command) {
    const classification = classifyCommand(command);
    switch (classification.level) {
        case 'readonly':
            logger.info('Command auto-approved (readonly)', {
                command,
                baseCommand: classification.baseCommand,
            });
            return {
                decision: 'approved',
                classification,
                message: `Auto-approved: ${classification.reason}`,
            };
        case 'write':
            logger.warn('Command requires confirmation (write)', {
                command,
                baseCommand: classification.baseCommand,
                reason: classification.reason,
            });
            return {
                decision: 'confirmation_required',
                classification,
                message: `Confirmation required: ${classification.reason}. The user can approve this command via the chat channel; it will then run through exec_confirm.`,
            };
        case 'dangerous':
            logger.error('Command BLOCKED (dangerous)', {
                command,
                baseCommand: classification.baseCommand,
                reason: classification.reason,
            });
            return {
                decision: 'blocked',
                classification,
                message: `Blocked: ${classification.reason}`,
            };
    }
}
//# sourceMappingURL=approval.js.map