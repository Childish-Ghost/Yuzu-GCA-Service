/**
 * Settings Store - persistent local JSON configuration (P-011).
 *
 * A flat key-value JSON file for non-secret settings (device name overrides,
 * proxy config, feature flags). Secrets NEVER go here — use credential-store.
 *
 *   - Location: GCA_SETTINGS_PATH env, default <poc>/settings.json
 *   - Writes are atomic (write tmp file + rename) — a crash mid-write can
 *     never truncate the settings file
 *   - Read-through cache; call reload() after external edits
 */
export declare function getSettingsPath(): string;
/** Returns one setting, or undefined if absent. */
export declare function getSetting<T = unknown>(key: string): Promise<T | undefined>;
/** Returns the whole settings object (read-only snapshot). */
export declare function getAllSettings(): Promise<Record<string, unknown>>;
/** Sets one setting and persists atomically. */
export declare function setSetting(key: string, value: unknown): Promise<void>;
/** Deletes one setting and persists atomically. */
export declare function deleteSetting(key: string): Promise<void>;
/** Drops the read-through cache (call after editing the file externally). */
export declare function reloadSettings(): void;
