import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  SETTINGS_RANGES,
  type SettingKey,
  type SettingRange,
  type SettingValue,
  type SettingsValues,
} from '@sql-approval/shared';

import { ApiError, isRecord } from './errors.js';
import type { Store } from './store.js';

export interface SettingsSnapshot {
  settings: SettingsValues;
  defaults: SettingsValues;
  ranges: Record<SettingKey, SettingRange>;
}

/** True when `key` is part of the configurable batch-A settings contract. */
export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

function inRange(key: SettingKey, value: unknown): value is SettingValue {
  const range = SETTINGS_RANGES[key];
  if (range.type === 'boolean') return typeof value === 'boolean';
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    range.min !== undefined &&
    range.max !== undefined &&
    value >= range.min &&
    value <= range.max
  );
}

function rangeMessage(key: SettingKey): string {
  const range = SETTINGS_RANGES[key];
  if (range.type === 'boolean') return `${key} must be a boolean`;
  return `${key} must be an integer between ${range.min} and ${range.max}`;
}

/**
 * Reads every known setting, falling back to the shared default when a row is
 * missing or holds an invalid value. Reads are intentionally uncached: the
 * request path always observes the value committed by the latest PUT.
 */
export function readSettings(store: Pick<Store, 'listSettings'>): SettingsValues {
  const settings = { ...DEFAULT_SETTINGS } as Record<SettingKey, SettingValue>;
  const stored = store.listSettings();
  for (const key of SETTING_KEYS) {
    const raw = stored[key];
    if (raw === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (inRange(key, parsed)) settings[key] = parsed;
    } catch {
      // A malformed row falls back to the default instead of breaking requests.
    }
  }
  return settings as SettingsValues;
}

/** `{settings, defaults, ranges}` payload shared by GET and PUT responses. */
export function settingsSnapshot(store: Pick<Store, 'listSettings'>): SettingsSnapshot {
  return {
    settings: readSettings(store),
    defaults: { ...DEFAULT_SETTINGS },
    ranges: { ...SETTINGS_RANGES },
  };
}

/**
 * Validates a partial settings object. Unknown keys, wrong types and
 * out-of-range integers are rejected with 400 before anything is written.
 */
export function parseSettingsPatch(body: unknown): Partial<SettingsValues> {
  if (!isRecord(body)) {
    throw new ApiError('INVALID_REQUEST', 400, 'Settings body must be a JSON object');
  }
  const patch: Partial<Record<SettingKey, SettingValue>> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) {
      throw new ApiError('INVALID_REQUEST', 400, `Unknown setting: ${key}`);
    }
    if (!inRange(key, value)) {
      throw new ApiError('INVALID_REQUEST', 400, rangeMessage(key));
    }
    patch[key] = value;
  }
  return patch as Partial<SettingsValues>;
}

/** Serializes the changed keys for the settings table (value is JSON). */
export function encodeSettingsPatch(patch: Partial<SettingsValues>): Record<string, string> {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) encoded[key] = JSON.stringify(value);
  }
  return encoded;
}
