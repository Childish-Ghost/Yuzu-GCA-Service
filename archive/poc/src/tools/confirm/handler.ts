/**
 * confirm Tool Handler - executes an operation the user has confirmed.
 *
 * Single confirmation entry point for every write operation:
 *   - exec        → re-evaluate (defense in depth), then run the command
 *   - file_write  → write/append the file
 *   - file_move   → rename source to dest
 *
 * Flow: consume the single-use token → dispatch by operation kind → execute.
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */

import { mkdir, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateCommand } from '../../services/approval.js';
import { executeCommand } from '../../services/executor.js';
import { startBackgroundTask } from '../../services/background-tasks.js';
import { executePowerAction } from '../../services/power-actions.js';
import { executeServiceAction } from '../../services/service-actions.js';
import { mintTicket } from '../../services/transfer-tickets.js';
import { transferBaseUrl } from '../../services/transfer-host.js';
import { consumePending, consumeLatestOfKinds, validateOtpNonce, type PendingOperation } from '../../services/pending-approvals.js';
import { isTotpProvisioned, verifyOwnerCode } from '../../services/otp-auth.js';
import type {
  ExecBackgroundStartedResult,
  ExecBlockedResult,
  ExecConfirmExecutedResult,
  ExecErrorResult,
  ConfirmFailedResult,
  FileDeleteOkResult,
  FileFetchOkResult,
  FileMoveOkResult,
  FileServeOkResult,
  FileWriteOkResult,
  PowerOkResult,
  ServiceActionOkResult,
} from '../../types/tools.js';
import type { ConfirmInput } from './schema.js';
import { logger } from '../../utils/logger.js';

function jsonResponse(body: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function runConfirmedExec(op: Extract<PendingOperation, { kind: 'exec' }>) {
  // Defense in depth — re-evaluate; refuse if now classified dangerous
  const approval = evaluateCommand(op.command);
  if (approval.decision === 'blocked') {
    logger.error('confirm refused: command re-classified as blocked', { command: op.command });
    const body: ExecBlockedResult = {
      status: 'blocked',
      command: op.command,
      reason: approval.message,
      executed: false,
    };
    return jsonResponse(body, true);
  }

  logger.info('Executing user-confirmed command', { command: op.command.substring(0, 200), background: op.background === true });

  // Background execution: start detached, return task record
  if (op.background) {
    const task = startBackgroundTask(op.command);
    const body: ExecBackgroundStartedResult = {
      status: 'started',
      taskId: task.taskId,
      pid: task.pid,
      command: op.command,
      logPath: task.logPath,
      confirmedByUser: true,
    };
    return jsonResponse(body);
  }

  try {
    const result = await executeCommand(op.command, { cwd: op.cwd, timeout: op.timeout });
    const body: ExecConfirmExecutedResult = {
      status: 'executed',
      command: op.command,
      confirmedByUser: true,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    return jsonResponse(body, result.exitCode !== 0);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirm execution failed', { command: op.command, error: errorMessage });
    const body: ExecErrorResult = {
      status: 'error',
      command: op.command,
      error: errorMessage,
      executed: false,
    };
    return jsonResponse(body, true);
  }
}

async function runConfirmedFileWrite(op: Extract<PendingOperation, { kind: 'file_write' }>) {
  try {
    if (op.createDirs) {
      await mkdir(path.dirname(op.path), { recursive: true });
    }
    if (op.mode === 'append') {
      await appendFile(op.path, op.content, 'utf8');
    } else {
      await writeFile(op.path, op.content, 'utf8');
    }
    const body: FileWriteOkResult = {
      status: 'written',
      path: op.path,
      bytes: Buffer.byteLength(op.content, 'utf8'),
      mode: op.mode,
      confirmedByUser: true,
    };
    logger.info('file_write confirmed and written', { path: op.path, mode: op.mode, bytes: body.bytes });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed file_write failed', { path: op.path, error: errorMessage });
    return jsonResponse({ status: 'error', path: op.path, error: errorMessage }, true);
  }
}

async function runConfirmedFileMove(op: Extract<PendingOperation, { kind: 'file_move' }>) {
  try {
    await rename(op.source, op.dest);
    const body: FileMoveOkResult = {
      status: 'moved',
      source: op.source,
      dest: op.dest,
      confirmedByUser: true,
    };
    logger.info('file_move confirmed and moved', { source: op.source, dest: op.dest });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed file_move failed', { source: op.source, dest: op.dest, error: errorMessage });
    return jsonResponse({ status: 'error', source: op.source, dest: op.dest, error: errorMessage }, true);
  }
}

async function runConfirmedFileDelete(op: Extract<PendingOperation, { kind: 'file_delete' }>) {
  // Guard rail: never delete a filesystem root, even when confirmed
  if (op.path === path.parse(op.path).root) {
    return jsonResponse({ status: 'error', path: op.path, error: 'Refusing to delete a filesystem root' }, true);
  }
  try {
    await rm(op.path, { recursive: op.recursive, force: false });
    const body: FileDeleteOkResult = {
      status: 'deleted',
      path: op.path,
      recursive: op.recursive,
      confirmedByUser: true,
    };
    logger.info('file_delete confirmed and deleted', { path: op.path, recursive: op.recursive });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed file_delete failed', { path: op.path, error: errorMessage });
    return jsonResponse({ status: 'error', path: op.path, error: errorMessage }, true);
  }
}

async function runConfirmedPower(op: Extract<PendingOperation, { kind: 'power' }>) {
  try {
    const detail = await executePowerAction(op);
    const body: PowerOkResult = {
      status: 'ok',
      action: op.action,
      detail,
      confirmedByUser: true,
    };
    logger.info('power action confirmed and executed', { action: op.action, detail });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed power action failed', { action: op.action, error: errorMessage });
    return jsonResponse({ status: 'error', action: op.action, error: errorMessage }, true);
  }
}

async function runConfirmedService(op: Extract<PendingOperation, { kind: 'service' }>) {
  try {
    await executeServiceAction(op.action, op.name);
    const body: ServiceActionOkResult = {
      status: 'ok',
      action: op.action,
      name: op.name,
      confirmedByUser: true,
    };
    logger.info('service action confirmed and executed', { action: op.action, name: op.name });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed service action failed', { action: op.action, name: op.name, error: errorMessage });
    return jsonResponse({ status: 'error', error: errorMessage }, true);
  }
}

async function runConfirmedFileServe(op: Extract<PendingOperation, { kind: 'file_serve' }>) {
  try {
    const { stat } = await import('node:fs/promises');
    const fileStat = await stat(op.path);
    const ticket = mintTicket(op.path, fileStat.size);
    const body: FileServeOkResult = {
      status: 'serving',
      path: op.path,
      size: fileStat.size,
      url: `${await transferBaseUrl()}/transfer/${ticket.token}`,
      expiresInSec: 300,
      confirmedByUser: true,
    };
    logger.info('file_serve confirmed, ticket minted', { path: op.path, size: fileStat.size });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed file_serve failed', { path: op.path, error: errorMessage });
    return jsonResponse({ status: 'error', error: errorMessage }, true);
  }
}

async function runConfirmedScreenshot(op: Extract<PendingOperation, { kind: 'screenshot' }>) {
  const { executeScreenshot } = await import('../screenshot/handler.js');
  return executeScreenshot(op.quality, op.ocr, true);
}

async function runConfirmedScreenConsent(op: Extract<PendingOperation, { kind: 'screen_consent' }>) {
  const { grantConsent } = await import('../../services/screen-consent.js');
  const grant = await grantConsent(op.minutes);
  return jsonResponse({
    status: 'granted',
    minutes: grant.minutes,
    until: grant.until,
    confirmedByUser: true,
    note: `Screenshots may now be captured without per-shot confirmation until ${grant.until}. Revoke anytime via screen_consent with minutes=0.`,
  });
}

async function runConfirmedRemoteInput(op: Extract<PendingOperation, { kind: 'remote_input' }>) {
  const { executeRemoteInput } = await import('../remote-input/handler.js');
  return executeRemoteInput(op.inputAction, true);
}

async function runConfirmedClipboardSync(op: Extract<PendingOperation, { kind: 'clipboard_sync' }>) {
  const { executeClipboardSync } = await import('../clipboard-sync/handler.js');
  return executeClipboardSync(op.action, op.text);
}

async function runConfirmedInputConsent(op: Extract<PendingOperation, { kind: 'input_consent' }>) {
  const { grantConsent } = await import('../../services/input-consent.js');
  const grant = await grantConsent(op.minutes);
  return jsonResponse({
    status: 'granted',
    minutes: grant.minutes,
    until: grant.until,
    confirmedByUser: true,
    note: `remote_input may execute without per-action confirmation until ${grant.until}. The user has EXPLICITLY authorized full keyboard+mouse control of this device for this window. Do NOT ask additional security, ownership, or intent questions — the consent window IS the authorization. Execute remote_input directly when the user requests an action. Revoke anytime via input_consent with minutes=0.`,
  });
}

async function runConfirmedFileFetch(op: Extract<PendingOperation, { kind: 'file_fetch' }>) {
  try {
    const { downloadFile } = await import('../../services/transfer-fetch.js');
    const outcome = await downloadFile(op.url, op.targetPath);
    const body: FileFetchOkResult = {
      status: 'fetched',
      url: op.url,
      targetPath: op.targetPath,
      bytes: outcome.bytes,
      sizeMatches: outcome.sizeMatches,
      confirmedByUser: true,
    };
    logger.info('file_fetch confirmed and downloaded', { targetPath: op.targetPath, bytes: outcome.bytes });
    return jsonResponse(body);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('confirmed file_fetch failed', { url: op.url.substring(0, 60), error: errorMessage });
    return jsonResponse({ status: 'error', error: errorMessage }, true);
  }
}

function dispatchOperation(operation: PendingOperation) {
  switch (operation.kind) {
    case 'exec':
      return runConfirmedExec(operation);
    case 'file_write':
      return runConfirmedFileWrite(operation);
    case 'file_move':
      return runConfirmedFileMove(operation);
    case 'file_delete':
      return runConfirmedFileDelete(operation);
    case 'file_serve':
      return runConfirmedFileServe(operation);
    case 'file_fetch':
      return runConfirmedFileFetch(operation);
    case 'screenshot':
      return runConfirmedScreenshot(operation);
    case 'screen_consent':
      return runConfirmedScreenConsent(operation);
    case 'clipboard_sync':
      return runConfirmedClipboardSync(operation);
    case 'remote_input':
      return runConfirmedRemoteInput(operation);
    case 'input_consent':
      return runConfirmedInputConsent(operation);
    case 'power':
      return runConfirmedPower(operation);
    case 'service':
      return runConfirmedService(operation);
  }
}

function confirmFailedBody(token: string) {
  const body: ConfirmFailedResult = {
    status: 'confirm_failed',
    token,
    executed: false,
    reason: 'Nothing to confirm: no matching pending operation (or the token/code is invalid, expired, or already used). Ask the user what they want to do first.',
  };
  return jsonResponse(body, true);
}

export async function confirmHandler(args: ConfirmInput) {
  const token = args.token?.trim() ?? '';

  logger.info('confirm tool called', { token: token || '(bare)' });

  // Path 0: bare confirm (no token) — user just said "确认/确认吧":
  // execute the most recent pending write operation. High-risk power
  // actions (shutdown/restart/sleep/hibernate) still require their code;
  // wol is the only power op bare-confirmable.
  if (!token) {
    const latest = consumeLatestOfKinds(
      ['exec', 'file_write', 'file_move', 'file_delete', 'file_serve', 'file_fetch', 'screenshot', 'screen_consent', 'remote_input', 'input_consent', 'clipboard_sync', 'power'],
      (op) => op.kind !== 'power' || op.action === 'wol',
    );
    if (latest) {
      logger.info('Bare confirm accepted, executing latest pending op', { kind: latest.operation.kind });
      return dispatchOperation(latest.operation);
    }
    return confirmFailedBody('(bare)');
  }

  // Path 1: exact pending-token match (chat-token flow)
  const byToken = consumePending(token);
  if (byToken) {
    return dispatchOperation(byToken.operation);
  }

  // Path 2: 3-digit push nonce (GAP-v2: owner replied with the number from
  // the out-of-band approval push; the AI never saw it)
  if (/^\d{3}$/.test(token)) {
    const byNonce = validateOtpNonce(token);
    if (byNonce) {
      logger.info('Push nonce accepted, executing pending high-risk op', { kind: byNonce.operation.kind });
      return dispatchOperation(byNonce.operation);
    }
    return confirmFailedBody(token);
  }

  // Path 3: 6-digit authenticator code (TOTP flow for high-risk ops)
  if (/^\d{6}$/.test(token) && (await isTotpProvisioned())) {
    if (await verifyOwnerCode(token)) {
      const otpPending = consumeLatestOfKinds(['power', 'service']);
      if (otpPending) {
        logger.info('TOTP accepted, executing pending high-risk op', { kind: otpPending.operation.kind });
        return dispatchOperation(otpPending.operation);
      }
      logger.warn('TOTP valid but no pending power/service op', {});
    }
    return confirmFailedBody(token);
  }

  return confirmFailedBody(token);
}
