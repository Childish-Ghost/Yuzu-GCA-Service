/**
 * Background Task Registry - runs long commands detached, output to a log file.
 *
 * Design: no new tools needed for task inspection —
 *   - output: read the log file with the existing file_read tool
 *   - liveness: find the pid with the existing process_list tool
 *
 * Tasks are spawned detached via cmd/sh with stdout+stderr redirected to
 * %TEMP%/gca-task-<id>.log (or $TMPDIR). The child handle is kept in the
 * registry for exit-code tracking; children are unref'd so they never keep
 * the server alive.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface BackgroundTask {
  taskId: string;
  pid: number;
  command: string;
  logPath: string;
  startedAt: Date;
  exitCode: number | null;
}

const TASK_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const tasks = new Map<string, BackgroundTask & { child: ChildProcess }>();

function mintTaskId(): string {
  let id = 'T';
  for (let i = 0; i < 5; i++) {
    id += TASK_ID_ALPHABET[randomInt(TASK_ID_ALPHABET.length)];
  }
  return id;
}

/**
 * Starts a command in the background. Returns the task record.
 * The command runs through the shell (same semantics as the exec tool).
 */
export function startBackgroundTask(command: string): BackgroundTask {
  const taskId = mintTaskId();
  const logPath = path.join(tmpdir(), `gca-task-${taskId}.log`);

  // shell: true spawns cmd.exe (Windows) / sh (POSIX) with correct quoting;
  // redirect captures all output for later inspection via file_read.
  const shellCmd = `${command} > "${logPath}" 2>&1`;

  const child = spawn(shellCmd, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const task: BackgroundTask & { child: ChildProcess } = {
    taskId,
    pid: child.pid ?? -1,
    command,
    logPath,
    startedAt: new Date(),
    exitCode: null,
    child,
  };

  child.on('exit', (code) => {
    task.exitCode = code;
    logger.info('Background task exited', { taskId, exitCode: code });
  });
  child.on('error', (err) => {
    task.exitCode = -1;
    logger.error('Background task spawn error', { taskId, error: err.message });
  });

  tasks.set(taskId, task);
  logger.info('Background task started', { taskId, pid: task.pid, command: command.substring(0, 100) });

  const { child: _child, ...record } = task;
  return record;
}

/** Visible for testing / future task-status tooling. */
export function getBackgroundTask(taskId: string): BackgroundTask | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  const { child: _child, ...record } = task;
  return record;
}
