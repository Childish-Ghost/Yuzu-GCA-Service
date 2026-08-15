/**
 * Tool Registration - registers all MCP tools onto a server instance.
 *
 * Called for each new connection/session to avoid shared-state issues
 * between concurrent clients.
 *
 * Phase 2 tools: exec + confirm (approval loop) + file_list / file_read /
 * file_write / file_move + process_list + sysinfo.
 */
import { isRegistered } from '../services/registration.js';
import { execInputSchema } from './exec/schema.js';
import { execHandler } from './exec/handler.js';
import { confirmInputSchema } from './confirm/schema.js';
import { confirmHandler } from './confirm/handler.js';
import { fileListInputSchema } from './file-list/schema.js';
import { fileListHandler } from './file-list/handler.js';
import { fileReadInputSchema } from './file-read/schema.js';
import { fileReadHandler } from './file-read/handler.js';
import { fileWriteInputSchema } from './file-write/schema.js';
import { fileWriteHandler } from './file-write/handler.js';
import { fileMoveInputSchema } from './file-move/schema.js';
import { fileMoveHandler } from './file-move/handler.js';
import { fileServeInputSchema } from './file-serve/schema.js';
import { fileServeHandler } from './file-serve/handler.js';
import { fileFetchInputSchema } from './file-fetch/schema.js';
import { fileFetchHandler } from './file-fetch/handler.js';
import { fileDeleteInputSchema } from './file-delete/schema.js';
import { fileDeleteHandler } from './file-delete/handler.js';
import { execBackgroundInputSchema } from './exec-background/schema.js';
import { execBackgroundHandler } from './exec-background/handler.js';
import { processListInputSchema } from './process-list/schema.js';
import { processListHandler } from './process-list/handler.js';
import { powerInputSchema } from './power/schema.js';
import { powerHandler } from './power/handler.js';
import { serviceInputSchema } from './service/schema.js';
import { serviceHandler } from './service/handler.js';
import { notifySendInputSchema } from './notify-send/schema.js';
import { notifySendHandler } from './notify-send/handler.js';
import { screenshotInputSchema } from './screenshot/schema.js';
import { screenshotHandler } from './screenshot/handler.js';
import { screenConsentInputSchema } from './screen-consent/schema.js';
import { screenConsentHandler } from './screen-consent/handler.js';
import { remoteInputInputSchema } from './remote-input/schema.js';
import { remoteInputHandler } from './remote-input/handler.js';
import { inputConsentInputSchema } from './input-consent/schema.js';
import { inputConsentHandler } from './input-consent/handler.js';
import { clipboardSyncInputSchema } from './clipboard-sync/schema.js';
import { clipboardSyncHandler } from './clipboard-sync/handler.js';
import { sysinfoInputSchema } from './sysinfo/schema.js';
import { sysinfoHandler } from './sysinfo/handler.js';
export function registerTools(server) {
    // --- sysinfo always available (even unregistered) ---
    server.registerTool('sysinfo', {
        title: 'System Information',
        description: 'Get system information for this device: OS, CPU, memory, disk usage, ' +
            'network addresses and uptime. Read-only operation, auto-approved.',
        inputSchema: sysinfoInputSchema,
    }, sysinfoHandler);
    // Unregistered devices: only sysinfo + health are available.
    // Owner must approve registration via gca-server confirmation code.
    if (!isRegistered()) {
        return;
    }
    // exec tool — execute shell commands with three-level approval
    server.registerTool('exec', {
        title: 'Execute Command',
        description: 'Execute a shell command on this device. ' +
            'Read-only commands (ls, cat, grep, etc.) are auto-approved. ' +
            'Write operations (rm, mkdir, cp, etc.) do NOT execute immediately: ' +
            'they return a confirmToken — ask the user to confirm, then call ' +
            'confirm with that token to run the command. ' +
            'Dangerous commands (rm -rf /, format, shutdown, etc.) are blocked.',
        inputSchema: execInputSchema,
    }, execHandler);
    // confirm tool — the single approval entry point for all write operations
    server.registerTool('confirm', {
        title: 'Confirm Pending Operation',
        description: 'Execute the operation the user just confirmed in chat. ' +
            'Call with NO arguments to execute the most recent pending ' +
            'operation (exec, file_write/move/delete/serve/fetch, wol). ' +
            'Only for power/service operations does the user supply a code ' +
            '(3-digit push nonce or 6-digit authenticator code) — pass that ' +
            'code as the token argument in that case only.',
        inputSchema: confirmInputSchema,
    }, confirmHandler);
    // file_list tool — list directory contents (read-only, no approval)
    server.registerTool('file_list', {
        title: 'List Files',
        description: 'List the contents of a directory on this device. ' +
            'Supports wildcard filtering (e.g. "*.pdf") and optional recursion. ' +
            'Read-only operation, auto-approved.',
        inputSchema: fileListInputSchema,
    }, fileListHandler);
    // file_read tool — read a text file with optional line range (read-only)
    server.registerTool('file_read', {
        title: 'Read File',
        description: 'Read the content of a text file on this device. ' +
            'Supports 1-based line ranges (startLine/endLine). ' +
            'Binary files and files over 64MB are refused; output caps at 4000 lines / 512KB. ' +
            'Read-only operation, auto-approved.',
        inputSchema: fileReadInputSchema,
    }, fileReadHandler);
    // file_write tool — write/append a file (requires confirmation)
    server.registerTool('file_write', {
        title: 'Write File',
        description: 'Write or append text content to a file on this device. ' +
            'This is a write operation: it does NOT execute immediately. ' +
            'It returns a confirmToken — ask the user to confirm, then call ' +
            'confirm with that token to perform the write.',
        inputSchema: fileWriteInputSchema,
    }, fileWriteHandler);
    // file_move tool — move/rename (requires confirmation)
    server.registerTool('file_move', {
        title: 'Move File',
        description: 'Move or rename a file or directory on this device. ' +
            'This is a write operation: it does NOT execute immediately. ' +
            'It returns a confirmToken — ask the user to confirm, then call ' +
            'confirm with that token to perform the move.',
        inputSchema: fileMoveInputSchema,
    }, fileMoveHandler);
    // file_delete tool — delete a file or directory (requires confirmation)
    server.registerTool('file_delete', {
        title: 'Delete File',
        description: 'Delete a file or directory on this device. ' +
            'This is a write operation: it does NOT execute immediately. ' +
            'It returns a confirmToken — ask the user to confirm, then call ' +
            'confirm with that token to perform the delete. ' +
            'Non-empty directories require recursive=true.',
        inputSchema: fileDeleteInputSchema,
    }, fileDeleteHandler);
    // file_serve tool — publish a file for one-shot cross-device download
    server.registerTool('file_serve', {
        title: 'Serve File for Transfer',
        description: 'Publish a file on this device for a single one-shot download by ' +
            'another device (cross-device transfer, data plane direct). ' +
            'Requires confirmation; on confirm, returns a transfer URL valid ' +
            'for 5 minutes — pass it to file_fetch on the target device. ' +
            'The file content never passes through you.',
        inputSchema: fileServeInputSchema,
    }, fileServeHandler);
    // file_fetch tool — download a file from another device
    server.registerTool('file_fetch', {
        title: 'Fetch File from Device',
        description: 'Download a file directly from another device using the one-shot ' +
            'transfer URL returned by file_serve. ' +
            'Ticket URLs execute immediately (the ticket IS the authorization — ' +
            'no second confirmation needed). ' +
            'Non-ticket URLs require a confirmToken via the confirm tool.',
        inputSchema: fileFetchInputSchema,
    }, fileFetchHandler);
    // exec_background tool — long commands without blocking
    server.registerTool('exec_background', {
        title: 'Execute Command in Background',
        description: 'Start a long-running shell command in the background; returns a taskId ' +
            'and a logPath (read output with file_read, check liveness with process_list). ' +
            'Read-only commands start immediately; write operations return a confirmToken ' +
            'for the confirm tool; dangerous commands are blocked.',
        inputSchema: execBackgroundInputSchema,
    }, execBackgroundHandler);
    // process_list tool — running processes with sorting (read-only)
    server.registerTool('process_list', {
        title: 'List Processes',
        description: 'List running processes on this device with CPU time and memory usage. ' +
            'Supports sorting (cpu/memory/pid/name), a name filter, and a result limit. ' +
            'Read-only operation, auto-approved.',
        inputSchema: processListInputSchema,
    }, processListHandler);
    // power tool — system power control (OTP verification for power actions)
    server.registerTool('power', {
        title: 'Power Control',
        description: 'Shutdown, restart, sleep, or hibernate this device, or send a Wake-on-LAN packet. ' +
            'Power actions require OTP verification: a code pops up on the device screen — ' +
            'the user must type it in chat, then you call confirm with that code. ' +
            'You never see the code yourself. wol uses a normal confirmToken instead.',
        inputSchema: powerInputSchema,
    }, powerHandler);
    // service tool — system service inspection and control
    server.registerTool('service', {
        title: 'Service Control',
        description: 'List system services (read-only, auto-approved) or start/stop/restart a service. ' +
            'Control actions require OTP verification: a code pops up on the device screen — ' +
            'the user must type it in chat, then you call confirm with that code. ' +
            'Service control usually requires an elevated process.',
        inputSchema: serviceInputSchema,
    }, serviceHandler);
    // notify_send tool — desktop notification to the device owner
    server.registerTool('notify_send', {
        title: 'Send Desktop Notification',
        description: 'Pop a desktop notification on this device to reach the human at the keyboard ' +
            '(status updates, task completion, heads-up before disruptive actions). ' +
            'Auto-approved.',
        inputSchema: notifySendInputSchema,
    }, notifySendHandler);
    // screenshot tool — capture the screen (privacy flow: consent window or per-shot confirm)
    server.registerTool('screenshot', {
        title: 'Screenshot',
        description: 'Capture everything currently visible on this device\'s screen as a JPEG ' +
            '(plus built-in OCR text). Privacy-sensitive: outside an active ' +
            'screen_consent window it requires confirmation per shot; inside the ' +
            'window it captures immediately.',
        inputSchema: screenshotInputSchema,
    }, screenshotHandler);
    // screen_consent tool — manage the screenshot permission window
    server.registerTool('screen_consent', {
        title: 'Screen Consent Window',
        description: 'Grant a time-boxed window (in minutes, max 120) during which the ' +
            'screenshot tool runs WITHOUT per-shot confirmation. Granting requires ' +
            'user confirmation; revoking (minutes=0) is instant and free. ' +
            'Use this when the user asks for continuous screen access.',
        inputSchema: screenConsentInputSchema,
    }, screenConsentHandler);
    // remote_input tool — keyboard + mouse control (highest risk, consent-gated)
    server.registerTool('remote_input', {
        title: 'Remote Input',
        description: 'Send keyboard + mouse events to this device\'s desktop. ' +
            'Actions: mouse_move (x,y), mouse_click (button + optional x,y), ' +
            'mouse_scroll (delta), key_type (text). ' +
            'When an input_consent window is active, execute IMMEDIATELY without ' +
            'asking additional questions — the consent window IS the user\'s ' +
            'authorization. Do not second-guess or ask about ownership/intent.',
        inputSchema: remoteInputInputSchema,
    }, remoteInputHandler);
    // input_consent tool — manage the remote_input permission window
    server.registerTool('input_consent', {
        title: 'Input Consent Window',
        description: 'Grant a time-boxed window (in minutes, max 120) during which ' +
            'remote_input runs WITHOUT per-action confirmation. Granting requires ' +
            'user confirmation; revoking (minutes=0) is instant and free. ' +
            'Use this when the user asks for continuous desktop control.',
        inputSchema: inputConsentInputSchema,
    }, inputConsentHandler);
    // clipboard_sync tool — read/write the system clipboard
    server.registerTool('clipboard_sync', {
        title: 'Clipboard Sync',
        description: 'Read or write the system clipboard on this device. ' +
            'get: return current clipboard text (may contain sensitive data). ' +
            'set: write text to the clipboard. ' +
            'Both actions require confirmation (privacy-sensitive).',
        inputSchema: clipboardSyncInputSchema,
    }, clipboardSyncHandler);
}
//# sourceMappingURL=register.js.map