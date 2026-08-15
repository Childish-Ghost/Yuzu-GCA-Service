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
export interface BackgroundTask {
    taskId: string;
    pid: number;
    command: string;
    logPath: string;
    startedAt: Date;
    exitCode: number | null;
}
/**
 * Starts a command in the background. Returns the task record.
 * The command runs through the shell (same semantics as the exec tool).
 */
export declare function startBackgroundTask(command: string): BackgroundTask;
/** Visible for testing / future task-status tooling. */
export declare function getBackgroundTask(taskId: string): BackgroundTask | undefined;
