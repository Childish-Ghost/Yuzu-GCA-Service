/**
 * Command Classifier - determines the risk level of a shell command.
 *
 * Three levels:
 *   - readonly:  safe to auto-execute (ls, cat, echo, etc.)
 *   - write:     modifies state, requires user confirmation (rm, mkdir, etc.)
 *   - dangerous: potentially destructive, blocked entirely (rm -rf /, format, etc.)
 */
// --- Readonly whitelist: commands that only read state, no side effects ---
// 注（2026-08-12 审查 C1，与 agent/src/approval.rs 对齐）：
//   curl/wget 移出——-o/-O/--output 可任意写盘，属审批绕过面；
//   node/python 移出——-c/-e 可执行任意代码并写盘。
//   三者现在落入「未知命令默认 write」分支，全部需确认。
const READONLY_COMMANDS = new Set([
    // File reading
    'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more',
    'grep', 'find', 'wc', 'file', 'stat', 'tree',
    // System info
    'df', 'du', 'ps', 'tasklist', 'systeminfo', 'whoami', 'hostname',
    'uname', 'uptime', 'free', 'top', 'htop', 'lscpu', 'lsblk',
    // Network diagnostics (read-only)
    'ipconfig', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute',
    'nslookup', 'dig',
    // Version/info
    'echo', 'date', 'cal', 'env', 'printenv', 'which', 'whereis',
    'git', 'docker',
]);
// --- Write list: commands that modify state ---
const WRITE_COMMANDS = new Set([
    // File operations
    'rm', 'del', 'rmdir', 'mkdir', 'md', 'touch', 'cp', 'copy',
    'mv', 'move', 'rename', 'chmod', 'chown', 'chattr',
    // Process management
    'kill', 'taskkill', 'systemctl', 'service',
    // Package management
    'npm', 'pnpm', 'yarn', 'pip', 'apt', 'apt-get', 'yum', 'brew',
    // Version control writes
    'git', // git push, git commit, etc. — but 'git status' is readonly...
    // Container management
    'docker', // docker stop/start — but 'docker ps' is readonly...
    // Other
    'echo', // echo with redirect (> file) is a write, handled in dangerous patterns
]);
// --- 下载写盘参数检测（C1 修复，与 agent/src/approval.rs has_download_flag 一致）---
// curl -o/-O/--output、wget -O/--output-document、-w/--write-out——即使无 `>`
// 重定向，这些参数同样任意写盘（审批绕过，2026-08-11 rust 已修、08-12 同步 node）
const DOWNLOAD_FLAGS = ['-o ', '-O', '--output', '--output-document', '-w ', '--write-out'];
function hasDownloadFlag(command) {
    return DOWNLOAD_FLAGS.some((flag) => command.includes(flag));
}
// --- Dangerous patterns: regex matched against the full command string ---
// These are checked FIRST, before any whitelist lookup.
const DANGEROUS_PATTERNS = [
    // Recursive force delete of root — matches -rf, -fr, -rvf, -frv, etc. (both r and f in any order)
    { pattern: /rm\s+(-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*|--recursive\s+--force|--force\s+--recursive).*\s+\//i, reason: 'Recursive force delete targeting root or absolute path' },
    // Recursive force delete with wildcard——.*\*$（以 * 结尾）与 rust ends_with('*')
    // 对齐：`rm -rf C:\*`（* 前非空白）此前漏拦，现一并阻止（C1 同步）
    { pattern: /rm\s+(-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*|--recursive\s+--force|--force\s+--recursive).*\*$/i, reason: 'Recursive force delete with wildcard' },
    // Disk formatting
    { pattern: /\b(format|fdisk|mkfs|dd)\b/i, reason: 'Disk formatting or raw disk write' },
    // System shutdown/reboot (must go through a dedicated power tool)
    { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: 'System shutdown/reboot must use the power tool (OTP verification required)' },
    // Alternate power-control routes — all must go through the OTP-verified power tool
    { pattern: /rundll32.*powrprof/i, reason: 'Sleep via rundll32 must use the power tool (OTP verification required)' },
    { pattern: /\b(restart-computer|stop-computer)\b/i, reason: 'PowerShell power cmdlets must use the power tool (OTP verification required)' },
    { pattern: /\bsystemctl\s+(poweroff|reboot|halt|suspend|hibernate)/i, reason: 'systemctl power actions must use the power tool (OTP verification required)' },
    { pattern: /\b(logoff|psshutdown)\b/i, reason: 'Session/power control must use the power tool (OTP verification required)' },
    // Fork bomb
    { pattern: /:\(\)\{.*:.*&.*\};:/, reason: 'Fork bomb detected' },
    // Pipe to shell (remote code execution)
    { pattern: /\b(curl|wget)\b.*\|\s*(bash|sh|zsh|fish)/i, reason: 'Remote script execution via pipe to shell' },
    // chmod 777 on root
    { pattern: /chmod\s+[-rwx]*777.*\s+\//i, reason: 'World-writable permissions on root path' },
    // Overwrite critical system files
    { pattern: />\s*\/(etc|proc|sys|dev)/i, reason: 'Attempt to overwrite system filesystem' },
    // Dev null redirect of important paths
    { pattern: />\s*\/dev\/null.*<(\/etc|\/proc|\/var)/i, reason: 'Redirecting critical system files to dev null' },
];
/**
 * Extracts the base command (first token) from a command string.
 * Handles quotes, pipes, and command chaining.
 */
export function extractBaseCommand(command) {
    const trimmed = command.trim();
    // Take the first token before any pipe, redirect, or chain operator
    const firstSegment = trimmed.split(/[|;&>]/)[0].trim();
    // Extract the command name (handle paths like /usr/bin/ls)
    const parts = firstSegment.split(/\s+/);
    const cmdPath = parts[0] || '';
    const baseName = cmdPath.split(/[/\\]/).pop() || cmdPath;
    return baseName.toLowerCase();
}
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
export function classifyCommand(command) {
    const trimmed = command.trim();
    const baseCommand = extractBaseCommand(trimmed);
    // Step 1: Check dangerous patterns first (highest priority)
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { level: 'dangerous', baseCommand, reason };
        }
    }
    // Check for output redirect — any redirect makes it at least 'write'
    const hasRedirect = />\s*\S/.test(trimmed) || hasDownloadFlag(trimmed);
    // Step 2: Handle compound commands (git, docker) with subcommand awareness
    if (baseCommand === 'git') {
        const subcommand = trimmed.split(/\s+/)[1]?.toLowerCase() || '';
        const gitReadonlySubs = new Set([
            'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag',
            'stash', 'blame', 'shortlog', 'describe', 'ls-files', 'cat-file', 'rev-parse',
        ]);
        if (gitReadonlySubs.has(subcommand) && !hasRedirect) {
            return { level: 'readonly', baseCommand, reason: `git ${subcommand} is read-only` };
        }
        return { level: 'write', baseCommand, reason: `git ${subcommand} modifies repository state` };
    }
    if (baseCommand === 'docker') {
        const subcommand = trimmed.split(/\s+/)[1]?.toLowerCase() || '';
        const dockerReadonlySubs = new Set([
            'ps', 'images', 'logs', 'inspect', 'stats', 'version', 'info',
            'top', 'history', 'port', 'search', 'network', 'volume',
        ]);
        if (dockerReadonlySubs.has(subcommand) && !hasRedirect) {
            return { level: 'readonly', baseCommand, reason: `docker ${subcommand} is read-only` };
        }
        return { level: 'write', baseCommand, reason: `docker ${subcommand} modifies container state` };
    }
    // Step 3: Check readonly whitelist
    if (READONLY_COMMANDS.has(baseCommand) && !hasRedirect) {
        return { level: 'readonly', baseCommand, reason: `${baseCommand} is in the read-only whitelist` };
    }
    // Step 4: Check write list
    if (WRITE_COMMANDS.has(baseCommand) || hasRedirect) {
        return { level: 'write', baseCommand, reason: hasRedirect ? 'Command contains output redirect' : `${baseCommand} modifies state` };
    }
    // Step 5: Unknown commands default to 'write' (require confirmation)
    return { level: 'write', baseCommand, reason: `Unknown command '${baseCommand}' — defaulting to require confirmation` };
}
//# sourceMappingURL=classifier.js.map