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
import { mintTicket } from '../../services/transfer-tickets.js';
import { transferBaseUrl } from '../../services/transfer-host.js';
import { consumePending, consumeLatestOfKinds } from '../../services/pending-approvals.js';
import { logger } from '../../utils/logger.js';
function jsonResponse(body, isError = false) {
    return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        ...(isError ? { isError: true } : {}),
    };
}
async function runConfirmedExec(op) {
    // Defense in depth — re-evaluate; refuse if now classified dangerous
    const approval = evaluateCommand(op.command);
    if (approval.decision === 'blocked') {
        logger.error('confirm refused: command re-classified as blocked', { command: op.command });
        const body = {
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
        const body = {
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
        const body = {
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
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirm execution failed', { command: op.command, error: errorMessage });
        const body = {
            status: 'error',
            command: op.command,
            error: errorMessage,
            executed: false,
        };
        return jsonResponse(body, true);
    }
}
async function runConfirmedFileWrite(op) {
    try {
        if (op.createDirs) {
            await mkdir(path.dirname(op.path), { recursive: true });
        }
        if (op.mode === 'append') {
            await appendFile(op.path, op.content, 'utf8');
        }
        else {
            await writeFile(op.path, op.content, 'utf8');
        }
        const body = {
            status: 'written',
            path: op.path,
            bytes: Buffer.byteLength(op.content, 'utf8'),
            mode: op.mode,
            confirmedByUser: true,
        };
        logger.info('file_write confirmed and written', { path: op.path, mode: op.mode, bytes: body.bytes });
        return jsonResponse(body);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirmed file_write failed', { path: op.path, error: errorMessage });
        return jsonResponse({ status: 'error', path: op.path, error: errorMessage }, true);
    }
}
async function runConfirmedFileMove(op) {
    try {
        await rename(op.source, op.dest);
        const body = {
            status: 'moved',
            source: op.source,
            dest: op.dest,
            confirmedByUser: true,
        };
        logger.info('file_move confirmed and moved', { source: op.source, dest: op.dest });
        return jsonResponse(body);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirmed file_move failed', { source: op.source, dest: op.dest, error: errorMessage });
        return jsonResponse({ status: 'error', source: op.source, dest: op.dest, error: errorMessage }, true);
    }
}
async function runConfirmedFileDelete(op) {
    // Guard rail: never delete a filesystem root, even when confirmed
    if (op.path === path.parse(op.path).root) {
        return jsonResponse({ status: 'error', path: op.path, error: 'Refusing to delete a filesystem root' }, true);
    }
    try {
        await rm(op.path, { recursive: op.recursive, force: false });
        const body = {
            status: 'deleted',
            path: op.path,
            recursive: op.recursive,
            confirmedByUser: true,
        };
        logger.info('file_delete confirmed and deleted', { path: op.path, recursive: op.recursive });
        return jsonResponse(body);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirmed file_delete failed', { path: op.path, error: errorMessage });
        return jsonResponse({ status: 'error', path: op.path, error: errorMessage }, true);
    }
}
async function runConfirmedFileServe(op) {
    try {
        const { stat } = await import('node:fs/promises');
        const fileStat = await stat(op.path);
        const ticket = mintTicket(op.path, fileStat.size);
        const body = {
            status: 'serving',
            path: op.path,
            size: fileStat.size,
            url: `${await transferBaseUrl()}/transfer/${ticket.token}`,
            expiresInSec: 300,
            confirmedByUser: true,
        };
        logger.info('file_serve confirmed, ticket minted', { path: op.path, size: fileStat.size });
        return jsonResponse(body);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirmed file_serve failed', { path: op.path, error: errorMessage });
        return jsonResponse({ status: 'error', error: errorMessage }, true);
    }
}
async function runConfirmedScreenshot(op) {
    const { executeScreenshot } = await import('../screenshot/handler.js');
    return executeScreenshot(op.quality, op.ocr, true);
}
async function runConfirmedScreenConsent(op) {
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
async function runConfirmedRemoteInput(op) {
    const { executeRemoteInput } = await import('../remote-input/handler.js');
    return executeRemoteInput(op.inputAction, true);
}
async function runConfirmedClipboardSync(op) {
    const { executeClipboardSync } = await import('../clipboard-sync/handler.js');
    return executeClipboardSync(op.action, op.text);
}
async function runConfirmedInputConsent(op) {
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
async function runConfirmedFileFetch(op) {
    try {
        const { downloadFile } = await import('../../services/transfer-fetch.js');
        const outcome = await downloadFile(op.url, op.targetPath);
        const body = {
            status: 'fetched',
            url: op.url,
            targetPath: op.targetPath,
            bytes: outcome.bytes,
            sizeMatches: outcome.sizeMatches,
            confirmedByUser: true,
        };
        logger.info('file_fetch confirmed and downloaded', { targetPath: op.targetPath, bytes: outcome.bytes });
        return jsonResponse(body);
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error('confirmed file_fetch failed', { url: op.url.substring(0, 60), error: errorMessage });
        return jsonResponse({ status: 'error', error: errorMessage }, true);
    }
}
function dispatchOperation(operation) {
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
    }
}
function confirmFailedBody(token) {
    const body = {
        status: 'confirm_failed',
        token,
        executed: false,
        reason: 'Nothing to confirm: no matching pending operation (or the token/code is invalid, expired, or already used). Ask the user what they want to do first.',
    };
    return jsonResponse(body, true);
}
export async function confirmHandler(args) {
    const token = args.token?.trim() ?? '';
    logger.info('confirm tool called', { token: token || '(bare)' });
    // Path 0: bare confirm (no token) — user just said "确认/确认吧":
    // execute the most recent pending write operation. High-risk power
    // actions (shutdown/restart/sleep/hibernate) still require their code;
    // wol is the only power op bare-confirmable.
    if (!token) {
        const latest = consumeLatestOfKinds(['exec', 'file_write', 'file_move', 'file_delete', 'file_serve', 'file_fetch', 'screenshot', 'screen_consent', 'remote_input', 'input_consent', 'clipboard_sync']);
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
    return confirmFailedBody(token);
}
//# sourceMappingURL=handler.js.map