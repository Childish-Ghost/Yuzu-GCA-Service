/**
 * Command Classifier - determines the risk level of a shell command.
 *
 * Three levels:
 *   - readonly:  safe to auto-execute (ls, cat, echo, etc.)
 *   - write:     modifies state, requires user confirmation (rm, mkdir, etc.)
 *   - dangerous: potentially destructive, blocked entirely (rm -rf /, format, etc.)
 */
export type CommandLevel = 'readonly' | 'write' | 'dangerous';
export interface ClassificationResult {
    level: CommandLevel;
    baseCommand: string;
    reason: string;
}
/**
 * Extracts the base command (first token) from a command string.
 * Handles quotes, pipes, and command chaining.
 */
export declare function extractBaseCommand(command: string): string;
/**
 * Classifies a command string into one of three risk levels.
 *
 * Evaluation order:
 *   1. Dangerous patterns (regex) — if matched, immediately return 'dangerous'
 *   2. Readonly whitelist — if base command is in the set AND no redirect, return 'readonly'
 *   3. Write list — if base command is in the set, return 'write'
 *   4. Unknown commands default to 'write' (require confirmation)
 *
 * Special handling:
 *   - Commands with output redirect (>) are at least 'write'
 *   - 'git' and 'docker' subcommands: readonly for status/ps/logs, write for mutations
 */
export declare function classifyCommand(command: string): ClassificationResult;
