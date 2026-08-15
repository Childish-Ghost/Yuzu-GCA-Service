/**
 * Pairing setup: generates (or rotates) the MCP pairing token and prints
 * the gateway-side config snippet.
 *
 *   npm run setup:pairing            — generate if absent
 *   npm run setup:pairing -- --force — rotate (old token dies; update the
 *                                      gateway config immediately after)
 *
 * The token lives in settings.json (device) and in the gateway's
 * mcp.servers.gca-poc.headers (gateway). Both sides must match.
 */

import { generatePairingToken } from '../src/services/pairing.js';
import { getSetting, setSetting } from '../src/services/settings-store.js';
import { config } from '../src/config.js';

const force = process.argv.includes('--force');
const existing = await getSetting<string>('security.mcpToken');

if (existing && !force) {
  console.log('A pairing token already exists. Gateway snippet:\n');
  printSnippet(existing);
  console.log('\nRun with --force to rotate (invalidates the current token).');
  process.exit(0);
}

const token = generatePairingToken();
await setSetting('security.mcpToken', token);

console.log(existing ? 'Pairing token ROTATED.' : 'Pairing token generated.');
console.log('Stored in settings.json (security.mcpToken).\n');
printSnippet(token);
console.log('\nApply on the gateway, then restart it. All MCP calls without the token will get 401.');

function printSnippet(t: string): void {
  console.log('=== Gateway config (openclaw.json → mcp.servers.gca-poc) ===');
  console.log(JSON.stringify({
    url: `http://<this-device-ip>:${config.port}/mcp`,
    transport: 'streamable-http',
    headers: { Authorization: `Bearer ${t}` },
  }, null, 2));
}
