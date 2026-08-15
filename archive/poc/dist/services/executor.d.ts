/**
 * Command Executor - safely executes shell commands with timeout and output limits.
 *
 * Uses child_process.spawn to avoid shell injection (no shell: true).
 * Applies configurable timeout and output size limits.
 */
export interface ExecOptions {
    timeout?: number;
    maxOutput?: number;
    cwd?: string;
    env?: Record<string, string>;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
}
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
export declare function executeCommand(command: string, options?: ExecOptions): Promise<ExecResult>;
