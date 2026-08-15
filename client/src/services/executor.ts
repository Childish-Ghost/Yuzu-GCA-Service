/**
 * Command Executor - safely executes shell commands with timeout and output limits.
 *
 * Uses child_process.spawn to avoid shell injection (no shell: true).
 * Applies configurable timeout and output size limits.
 */

import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface ExecOptions {
  timeout?: number;       // milliseconds, default 30000
  maxOutput?: number;     // bytes, default 1MB
  cwd?: string;           // working directory
  env?: Record<string, string>;  // additional env vars
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

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
export function executeCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  // Android 沙箱 cwd 无权限（ls 直接 Permission denied），默认 cwd 固定到
  // /sdcard 可读目录；其他平台保持进程 cwd。桌面端也可通过 cwd 参数覆盖。
  const defaultCwd = process.platform === 'android' ? '/sdcard' : undefined;

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
      cwd: options.cwd ?? defaultCwd,
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

    // Windows cmd 输出是 GBK(CP936)，需转 UTF-8；其他平台 UTF-8
    const decoder = process.platform === 'win32'
      ? new TextDecoder('gbk')
      : new TextDecoder('utf-8');

    child.stdout?.on('data', (data: Buffer) => {
      if (stdoutBytes + data.length > maxOutput) {
        const remaining = maxOutput - stdoutBytes;
        if (remaining > 0) {
          stdout += decoder.decode(data.subarray(0, remaining));
        }
        truncated = true;
        child.kill('SIGTERM');
      } else {
        stdout += decoder.decode(data);
        stdoutBytes += data.length;
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (stderrBytes + data.length > maxOutput) {
        truncated = true;
      } else {
        stderr += decoder.decode(data);
        stderrBytes += data.length;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const result: ExecResult = {
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
