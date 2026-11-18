/**
 * Configurable gateway settings (batch A).
 *
 * Values are persisted in the `settings` table as `key -> JSON(value)`.
 * This module only carries the shared contract (keys, defaults, ranges); the
 * validation and enforcement logic lives in `@sql-approval/core`.
 */

export const SETTING_KEYS = [
  'session.idle_minutes',
  'session.absolute_hours',
  'proposal.default_max_rows',
  'proposal.max_max_rows',
  'proposal.default_timeout_s',
  'proposal.max_timeout_s',
  'proposal.approval_window_hours',
  'result.ttl_hours',
  'ui.show_countdown',
  'security.require_readonly_source',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingsValues {
  'session.idle_minutes': number;
  'session.absolute_hours': number;
  'proposal.default_max_rows': number;
  'proposal.max_max_rows': number;
  'proposal.default_timeout_s': number;
  'proposal.max_timeout_s': number;
  'proposal.approval_window_hours': number;
  'result.ttl_hours': number;
  'ui.show_countdown': boolean;
  'security.require_readonly_source': boolean;
}

export type SettingValue = SettingsValues[SettingKey];

export interface SettingRange {
  type: 'integer' | 'boolean';
  min?: number;
  max?: number;
}

export const DEFAULT_SETTINGS: Readonly<SettingsValues> = Object.freeze({
  'session.idle_minutes': 10,
  'session.absolute_hours': 8,
  'proposal.default_max_rows': 500,
  'proposal.max_max_rows': 5000,
  'proposal.default_timeout_s': 30,
  'proposal.max_timeout_s': 120,
  'proposal.approval_window_hours': 24,
  'result.ttl_hours': 24,
  'ui.show_countdown': true,
  'security.require_readonly_source': true,
});

/**
 * Inclusive ranges exposed through `GET /v1/admin/settings` so a UI can render
 * inputs and pre-validate; the server always re-validates on write.
 */
export const SETTINGS_RANGES: Readonly<Record<SettingKey, SettingRange>> = Object.freeze({
  'session.idle_minutes': { type: 'integer', min: 1, max: 1440 },
  'session.absolute_hours': { type: 'integer', min: 1, max: 24 },
  'proposal.default_max_rows': { type: 'integer', min: 1, max: 5000 },
  'proposal.max_max_rows': { type: 'integer', min: 100, max: 5000 },
  'proposal.default_timeout_s': { type: 'integer', min: 1, max: 120 },
  'proposal.max_timeout_s': { type: 'integer', min: 1, max: 120 },
  'proposal.approval_window_hours': { type: 'integer', min: 1, max: 168 },
  'result.ttl_hours': { type: 'integer', min: 1, max: 168 },
  'ui.show_countdown': { type: 'boolean' },
  'security.require_readonly_source': { type: 'boolean' },
});
