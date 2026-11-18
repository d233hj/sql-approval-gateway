import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateMssqlReadonly,
  evaluatePostgresReadonly,
  parseMysqlGrants,
  sanitizeServerVersion,
} from '../src/probes.js';

test('mssql probe: non-sysadmin without INSERT is read-only', () => {
  const result = evaluateMssqlReadonly({ is_sysadmin: 0, can_insert: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.match(result.details.join(' '), /非 sysadmin/);

  // Driver numeric columns may arrive as numeric strings.
  assert.equal(evaluateMssqlReadonly({ is_sysadmin: '0', can_insert: '0' }).ok, true);
});

test('mssql probe: sysadmin or INSERT permission fails the read-only check', () => {
  const sysadmin = evaluateMssqlReadonly({ is_sysadmin: 1, can_insert: 0 });
  assert.equal(sysadmin.ok, false);
  assert.equal(sysadmin.checked, true);
  assert.match(sysadmin.details.join(' '), /sysadmin/);

  const insert = evaluateMssqlReadonly({ is_sysadmin: 0, can_insert: 1 });
  assert.equal(insert.ok, false);
  assert.equal(insert.checked, true);
  assert.match(insert.details.join(' '), /INSERT/);

  const both = evaluateMssqlReadonly({ is_sysadmin: 1, can_insert: 1 });
  assert.equal(both.ok, false);
  assert.equal(both.details.length, 2);
});

test('mssql probe: missing fields fail closed', () => {
  for (const row of [null, {}, { is_sysadmin: null, can_insert: 0 }, { is_sysadmin: 0 }]) {
    const result = evaluateMssqlReadonly(row);
    assert.equal(result.ok, false);
    assert.equal(result.checked, false);
    assert.ok(result.details.length > 0);
  }
});

test('mysql probe: SELECT/USAGE grants are read-only', () => {
  const select = parseMysqlGrants([
    "GRANT SELECT, SHOW VIEW ON `demo`.* TO 'reader'@'%'",
    "GRANT USAGE ON *.* TO 'reader'@'%'",
    // A table/account named "all" must not be mistaken for ALL PRIVILEGES.
    "GRANT SELECT ON `all`.* TO 'all'@'%'",
  ]);
  assert.equal(select.ok, true);
  assert.equal(select.checked, true);
});

test('mysql probe: INSERT/UPDATE/DELETE/ALL grants fail the read-only check', () => {
  for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'ALL PRIVILEGES']) {
    const result = parseMysqlGrants([`GRANT ${keyword} ON demo.* TO 'writer'@'%'`]);
    assert.equal(result.ok, false, keyword);
    assert.equal(result.checked, true, keyword);
    assert.match(result.details.join(' '), new RegExp(keyword.split(' ')[0]!));
  }

  const mixed = parseMysqlGrants([
    "GRANT SELECT, INSERT ON demo.* TO 'writer'@'%'",
    "GRANT UPDATE ON demo.* TO 'writer'@'%'",
  ]);
  assert.equal(mixed.ok, false);
  assert.match(mixed.details.join(' '), /INSERT, UPDATE/);
});

test('mysql probe: an unavailable GRANT list is unverified, not a failure', () => {
  const result = parseMysqlGrants([]);
  assert.equal(result.ok, true);
  assert.equal(result.checked, false);
  assert.match(result.details.join(' '), /未验证写权限/);
});

test('postgres probe: only an explicit read-only session proves write protection', () => {
  const on = evaluatePostgresReadonly('on');
  assert.deepEqual(on, { ok: true, checked: true, details: ['default_transaction_read_only=on'] });

  for (const value of ['off', 'false', 0, null, 'unknown']) {
    const result = evaluatePostgresReadonly(value);
    assert.equal(result.ok, true);
    assert.equal(result.checked, false);
    assert.match(result.details.join(' '), /未验证写权限/);
  }
});

test('probe server versions are sanitized to one bounded line', () => {
  assert.equal(
    sanitizeServerVersion('Microsoft SQL Server 2022 (RTM) - 16.0.1000.6 (X64)\nDec 5 2022'),
    'Microsoft SQL Server 2022 (RTM) - 16.0.1000.6 (X64)',
  );
  assert.equal(sanitizeServerVersion('x'.repeat(500))?.length, 160);
  assert.equal(sanitizeServerVersion('  line one\nline two  '), 'line one');
  assert.equal(sanitizeServerVersion(undefined), undefined);
  assert.equal(sanitizeServerVersion('   '), undefined);
});
