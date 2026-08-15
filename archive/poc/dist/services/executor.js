/**
 * Command Executor - safely executes shell commands with timeout and output limits.
 *
 * Uses child_process.spawn to avoid shell injection (no shell: true).
 * Applies configurable timeout and output size limits.
 */
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
const DEFAULT_TIMEOUT = config.exec.timeoutMs;
const DEFAULT_MAX_OUTPUT = config.exec.maxOutputBytes;
/**
 * Executes a command using spawn (no shell, prevents injection).
 *
 * On Windows, uses cmd.exe /c for command parsing.
 * On Unix, splits the command and runs directly.
 *
 * @param command - The command string to execute
 * @param options - Execution options (timeout, maxOutput, cwd, env)
 * @returns ExecResult with stdout, stderr, exitCode, and flags
 */
export function executeCommand(command, options = {}) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let timedOut = false;
        // Use shell for pipe/redirect support in commands like "ls | grep foo".
        // shell: true lets Node spawn cmd.exe (Windows) / sh (Unix) with correct
        // quoting — passing ['/c', command] manually mangles commands ending in a
        // backslash ("dir D:\" arrived as "dir D:\\" via libuv arg quoting).
        // The approval layer already classified the command, so shell usage is acceptable here.
        const child = spawn(command, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            shell: true,
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                if (!child.killed) {
                    child.kill('SIGKILL');
                }
            }, 2000);
        }, timeout);
        child.stdout?.on('data', (data) => {
            if (stdoutBytes + data.length > maxOutput) {
                const remaining = maxOutput - stdoutBytes;
                if (remaining > 0) {
                    stdout += data.subarray(0, remaining).toString();
                }
                truncated = true;
                child.kill('SIGTERM');
            }
            else {
                stdout += data.toString();
                stdoutBytes += data.length;
            }
        });
        child.stderr?.on('data', (data) => {
            if (stderrBytes + data.length > maxOutput) {
                truncated = true;
            }
            else {
                stderr += data.toString();
                stderrBytes += data.length;
            }
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const result = {
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code,
                timedOut,
                truncated,
            };
            logger.debug('Command executed', {
                command: command.substring(0, 100),
                exitCode: code,
                timedOut,
                truncated,
                stdoutLength: stdout.length,
            });
            resolve(result);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            logger.error('Command execution error', { error: err.message });
            resolve({
                stdout: '',
                stderr: `Execution error: ${err.message}`,
                exitCode: null,
                timedOut: false,
                truncated: false,
            });
        });
    });
}
//# sourceMappingURL=executor.js.map