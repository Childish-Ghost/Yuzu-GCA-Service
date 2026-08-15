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

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const DEFAULT_PATH = path.resolve(process.cwd(), 'settings.json');
const settingsPath = process.env.GCA_SETTINGS_PATH
  ? path.resolve(process.env.GCA_SETTINGS_PATH)
  : DEFAULT_PATH;

let cache: Record<string, unknown> | null = null;

async function load(): Promise<Record<string, unknown>> {
  if (cache !== null) return cache;
  try {
    const text = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(text);
    cache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Missing or unreadable file → start empty (first run is normal)
    cache = {};
  }
  return cache!;
}

export function getSettingsPath(): string {
  return settingsPath;
}

/** Returns one setting, or undefined if absent. */
export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const settings = await load();
  return settings[key] as T | undefined;
}

/** Returns the whole settings object (read-only snapshot). */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  return { ...(await load()) };
}

/** Sets one setting and persists atomically. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const settings = await load();
  settings[key] = value;
  await persist();
}

/** Deletes one setting and persists atomically. */
export async function deleteSetting(key: string): Promise<void> {
  const settings = await load();
  delete settings[key];
  await persist();
}

/** Drops the read-through cache (call after editing the file externally). */
export function reloadSettings(): void {
  cache = null;
}

async function persist(): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  await rename(tmp, settingsPath);
  logger.info('Settings persisted', { path: settingsPath, keys: Object.keys(cache ?? {}).length });
}
