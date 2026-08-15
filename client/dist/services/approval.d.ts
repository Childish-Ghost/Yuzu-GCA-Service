/**
 * Approval Service - enforces the three-level command approval policy.
 *
 * Level 1 (readonly):  Auto-approve and execute immediately.
 * Level 2 (write):     Require explicit confirmation.
 *                       POC: returns a "confirmation required" response.
 *                       Production: integrate with chat channel or UI prompt.
 * Level 3 (dangerous): Block immediately, log to security audit trail.
 */
import { type ClassificationResult } from './classifier.js';
export type ApprovalDecision = 'approved' | 'confirmation_required' | 'blocked';
export interface ApprovalResult {
    decision: ApprovalDecision;
    classification: ClassificationResult;
    message: string;
}
/**
 * Evaluates a command against the three-level approval policy.
 *
 * @param command - The raw command string to evaluate
 * @returns ApprovalResult with the decision and explanation
 */
export declare function evaluateCommand(command: string): ApprovalResult;
