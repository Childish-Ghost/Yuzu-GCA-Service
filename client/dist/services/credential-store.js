/**
 * Credential Store - per-user secret storage.
 *
 * Windows: DPAPI (CurrentUser scope) — ciphertext only decryptable by the
 *   same Windows user.
 * Linux/macOS: permission-based file store (~/.gca/secrets, dir 700, files
 *   600) — same protection model as ~/.aws/credentials and ~/.ssh. Marked
 *   as 'file-perm' level; libsecret/keychain integration is a later upgrade.
 *
 * Secrets cross the process boundary via a child env var, never cmdline;
 * PowerShell uses -EncodedCommand (no quoting/injection surface).
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
function secretsDir() {
    // Resolved per call (not at module load) so tests can redirect via env
    // without dynamic-import gymnastics.
    if (process.env.GCA_SECRETS_DIR) {
        return path.resolve(process.env.GCA_SECRETS_DIR);
    }
    return os.platform() === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'GCA', 'secrets')
        : path.join(os.homedir(), '.gca', 'secrets');
}
const APP_ENTROPY = 'gca-poc-v1';
const isWindows = os.platform() === 'win32';
let warnedFilePerm = false;
function noteFilePermLevel() {
    if (!warnedFilePerm) {
        logger.warn('credential store running in file-permission mode (600 perms, not encrypted) — use DPAPI-capable platform for stronger protection', {});
        warnedFilePerm = true;
    }
}
function sanitizeName(name) {
    if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(name)) {
        throw new Error(`Invalid secret name: ${name} (allowed: A-Za-z0-9_.- up to 64 chars)`);
    }
    return name;
}
const PS_ENCRYPT = `
Add-Type -AssemblyName System.Security;
$b=[Text.Encoding]::UTF8.GetBytes($env:GCA_SECRET_VALUE);
$e=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${APP_ENTROPY}'),[Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($e))
`;
const PS_DECRYPT = `
Add-Type -AssemblyName System.Security;
$e=[Convert]::FromBase64String($env:GCA_SECRET_VALUE);
$b=[Security.Cryptography.ProtectedData]::Unprotect($e,[Text.Encoding]::UTF8.GetBytes('${APP_ENTROPY}'),[Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($b))
`;
function encodeCommand(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}
/** Runs a PowerShell script, passing `secretValue` via child env (never cmdline). */
function runPowerShell(script, secretValue) {
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
            env: { ...process.env, GCA_SECRET_VALUE: secretValue },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('PowerShell credential operation timed out'));
        }, 15000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve(stdout);
            else
                reject(new Error(stderr.trim().substring(0, 300) || `PowerShell exited ${code}`));
        });
    });
}
function secretPath(name) {
    return path.join(secretsDir(), `${sanitizeName(name)}.bin`);
}
/** Encrypts and stores a secret. Overwrites any existing entry. */
export async function setSecret(name, value) {
    await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
    if (isWindows) {
        const base64Cipher = await runPowerShell(PS_ENCRYPT, value);
        await writeFile(secretPath(name), base64Cipher, 'utf8');
        logger.info('Secret stored (DPAPI)', { name });
    }
    else {
        noteFilePermLevel();
        await writeFile(secretPath(name), value, { encoding: 'utf8', mode: 0o600 });
        logger.info('Secret stored (file-perm)', { name });
    }
}
/** Returns the decrypted secret, or null if absent. */
export async function getSecret(name) {
    let raw;
    try {
        raw = await readFile(secretPath(name), 'utf8');
    }
    catch {
        return null;
    }
    if (isWindows) {
        // Plaintext returns base64-encoded too — console codepages can't corrupt it
        const base64Plain = await runPowerShell(PS_DECRYPT, raw.trim());
        return Buffer.from(base64Plain.trim(), 'base64').toString('utf8');
    }
    return raw;
}
/** Deletes a secret. Returns true if it existed. */
export async function deleteSecret(name) {
    try {
        await unlink(secretPath(name));
        logger.info('Secret deleted', { name });
        return true;
    }
    catch {
        return false;
    }
}
/** Lists stored secret names (never values). */
export async function listSecretNames() {
    try {
        const files = await readdir(secretsDir());
        return files.filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)).sort();
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=credential-store.js.map