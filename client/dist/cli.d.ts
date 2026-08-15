/**
 * GCA CLI - device management commands (P-005).
 *
 *   gca start              Start the MCP server (background, logs to logs/dev-server.log)
 *   gca stop               Stop the MCP server
 *   gca status             Health / sessions / pairing / TOTP state
 *   gca doctor             Full diagnostics (port, auth, relay, tools, self-check)
 *   gca logs [n]           Print the last n lines of the server log (default 30)
 *   gca setup              Interactive first-run wizard (device name, port)
 *   gca service install    Register auto-start at login (schtasks / systemd --user)
 *   gca service uninstall  Remove auto-start
 *   gca service status     Auto-start registration state
 *
 * Zero dependencies beyond the project's own modules.
 */
export {};
