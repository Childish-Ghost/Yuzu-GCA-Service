/**
 * sysinfo Tool Handler - returns a snapshot of host system information.
 *
 * Read-only operation, no approval required.
 *
 * Uses only Node.js built-ins (os + fs.statfs) so the tool has zero
 * external dependencies. Notes:
 *   - os.loadavg() returns [0,0,0] on Windows (POSIX-only metric)
 *   - Disk stats cover the system drive of the current working directory
 *
 * Returns MCP content format: { content: [{ type: "text", text: "..." }] }
 */
export declare function sysinfoHandler(): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
