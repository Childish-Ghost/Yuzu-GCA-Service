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
/** Encrypts and stores a secret. Overwrites any existing entry. */
export declare function setSecret(name: string, value: string): Promise<void>;
/** Returns the decrypted secret, or null if absent. */
export declare function getSecret(name: string): Promise<string | null>;
/** Deletes a secret. Returns true if it existed. */
export declare function deleteSecret(name: string): Promise<boolean>;
/** Lists stored secret names (never values). */
export declare function listSecretNames(): Promise<string[]>;
