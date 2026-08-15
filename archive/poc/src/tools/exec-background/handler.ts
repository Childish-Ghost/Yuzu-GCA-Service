/**
 * exec_background Tool Handler - starts long commands without blocking.
 *
 * Same three-level approval as exec:
 *   - readonly commands start immediately, returning a taskId + logPath
 *   - write commands return a confirmToken (confirm tool starts the task)
 *   - dangerous commands are blocked
 *
 * Output goes to %TEMP%/gca-task-<id>.log — read it with file_read;
 * check liveness with process_list (filter by pid).
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import { evaluateCommand } from '../../services/approval.js';
import { startBackgroundTask } from '../../services/background-tasks.js';
import { createPending } from '../../services/pending-approvals.js';
import type {
  ExecBackgroundStartedResult,
  ExecBlockedResult,
  WriteOpConfirmationRequiredResult,
} from '../../types/tools.js';
import type { ExecBackgroundInput } from './schema.js';
import { logger } from '../../utils/logger.js';

export async function execBackgroundHandler(args: ExecBackgroundInput) {
  const { command } = args;

  logger.info('exec_background tool called', { command: command.substring(0, 200) });

  const approval = evaluateCommand(command);

  if (approval.decision === 'blocked') {
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

  if (approval.decision === 'confirmation_required') {
    createPending({
      operation: { kind: 'exec', command, background: true },
      reason: approval.message,
    });
    const body: WriteOpConfirmationRequiredResult = {
      status: 'confirmation_required',
      operation: 'exec_background',
      reason: `${approval.message} The command will start in the background once confirmed.`,
      executed: false,
      expiresInSec: 300,
      note: `Ask the user to confirm. When they agree, call the MCP tool named "confirm" with an empty object {} (do NOT use the /approve slash command — that is a different system). Expires in 300 seconds.`,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    };
  }

  const task = startBackgroundTask(command);
  const body: ExecBackgroundStartedResult = {
    status: 'started',
    taskId: task.taskId,
    pid: task.pid,
    command,
    logPath: task.logPath,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}
