/**
 * exec Tool Handler - the controller layer for command execution.
 *
 * Flow:
 *   1. Validate input (done by Zod schema at registration time)
 *   2. Evaluate command against three-level approval policy
 *   3. If approved: execute and return result
 *   4. If confirmation_required: return structured response (POC: no execution)
 *   5. If blocked: return error with reason, log to security audit
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import { evaluateCommand } from '../../services/approval.js';
import { executeCommand } from '../../services/executor.js';
import { createPending } from '../../services/pending-approvals.js';
import { audit } from '../../services/audit-client.js';
import type {
  ExecBlockedResult,
  ExecConfirmationRequiredResult,
  ExecErrorResult,
  ExecExecutedResult,
} from '../../types/tools.js';
import type { ExecInput } from './schema.js';
import { logger } from '../../utils/logger.js';

export async function execHandler(args: ExecInput) {
  const { command, cwd, timeout } = args;

  logger.info('exec tool called', { command: command.substring(0, 200) });

  // Step 1: Evaluate against approval policy
  const approval = evaluateCommand(command);

  // Step 2: Handle blocked commands
  if (approval.decision === 'blocked') {
    void audit({ action: 'exec_blocked', detail: command, status: 'blocked' }); // 安全事件（INT-005）
    const body: ExecBlockedResult = {
      status: 'blocked',
      command,
      reason: approval.message,
      executed: false,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      isError: true,
    };
  }

  // Step 3: Handle commands requiring confirmation — mint a single-use token
  // so the user can approve via the chat channel and the agent can complete
  // the execution with exec_confirm.
  if (approval.decision === 'confirmation_required') {
    createPending({
      operation: { kind: 'exec', command, cwd, timeout },
      reason: approval.message,
    });
    const body: ExecConfirmationRequiredResult = {
      status: 'confirmation_required',
      command,
      reason: approval.message,
      executed: false,
      expiresInSec: 300,
      note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  }

  // Step 4: Approved — execute the command
  try {
    const result = await executeCommand(command, { cwd, timeout });

    const response: ExecExecutedResult = {
      status: 'executed',
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    // 免审批执行（INT-005）
    void audit({ action: 'exec', detail: command, status: 'executed' });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      isError: result.exitCode !== 0,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('exec tool execution failed', { command, error: errorMessage });

    const body: ExecErrorResult = {
      status: 'error',
      command,
      error: errorMessage,
      executed: false,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
      isError: true,
    };
  }
}
