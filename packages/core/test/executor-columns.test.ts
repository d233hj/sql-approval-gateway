import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { resolveMssqlColumns } from '../src/executor/mssql.js';
import { executeSqliteQuery, resolveSqliteColumns } from '../src/executor/sqlite.js';
import type { CancelToken, ConnectorResult } from '../src/executor/types.js';

function neverCancelled(): CancelToken {
  return { cancelled: false, onCancel: () => () => {} };
}

function createColumnsDatabase(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sag-columns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'columns.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(7, 'seven');
  } finally {
    db.close();
  }
  return file;
}

function execute(file: string, sql: string): Promise<ConnectorResult> {
  return executeSqliteQuery({ file }, sql, null, {
    maxRows: 10,
    timeoutMs: 5000,
    cancel: neverCancelled(),
  });
}

test('sqlite: SELECT * reports the real column names', async (t) => {
  const file = createColumnsDatabase(t);
  const result = await execute(file, 'SELECT * FROM t');
  assert.deepEqual(result.columns, [
    { name: 'a', type: 'INTEGER' },
    { name: 'b', type: 'TEXT' },
  ]);
  assert.deepEqual(result.rows, [[7, 'seven']]);
});

test('sqlite: SELECT aliases are reported as column names', async (t) => {
  const file = createColumnsDatabase(t);
  const result = await execute(file, 'SELECT a AS x, b FROM t');
  assert.deepEqual(result.columns, [
    { name: 'x', type: 'INTEGER' },
    { name: 'b', type: 'TEXT' },
  ]);
  assert.deepEqual(result.rows, [[7, 'seven']]);

  // Explicitly empty aliases used to leave every header blank. The display
  // fallback must not disturb the positional row cells.
  const unnamed = await execute(file, 'SELECT a AS "", b AS "" FROM t');
  assert.deepEqual(unnamed.columns, [
    { name: 'a', type: 'INTEGER' },
    { name: 'b', type: 'TEXT' },
  ]);
  assert.deepEqual(unnamed.rows, [[7, 'seven']]);
});

test('sqlite: column mapping tolerates name/column metadata variants', () => {
  // A runtime that reports an empty `name` still yields the SQL alias.
  assert.deepEqual(
    resolveSqliteColumns(
      [
        { name: '', column: 'a', type: 'INTEGER' },
        { name: '', column: 'b', type: null },
      ],
      'SELECT a AS x, b FROM t',
    ),
    [{ name: 'x', type: 'INTEGER' }, { name: 'b' }],
  );

  // `SELECT *` cannot be expanded from SQL: fall back to origin names.
  assert.deepEqual(
    resolveSqliteColumns(
      [
        { name: '', column: 'a' },
        { name: '', column: 'b' },
      ],
      'SELECT * FROM t',
    ),
    [{ name: 'a' }, { name: 'b' }],
  );
  assert.deepEqual(
    resolveSqliteColumns([{ name: '', column: 'a' }], 'SELECT * FROM one_column'),
    [{ name: 'a' }],
  );

  // An explicitly empty alias falls back to the expression text.
  assert.deepEqual(
    resolveSqliteColumns([{ name: '', column: null }], 'SELECT a + b AS "" FROM t'),
    [{ name: 'a + b' }],
  );

  // With no metadata and no parseable SELECT list a stable name is generated.
  assert.deepEqual(
    resolveSqliteColumns([{ name: null, column: null }], ''),
    [{ name: 'column_1' }],
  );
});

test('mssql: column mapping accepts array and object rowsets', () => {
  assert.deepEqual(
    resolveMssqlColumns([
      { name: 'one', type: { declaration: 'int' } },
      { name: 'two' },
    ]),
    [{ name: 'one', type: 'int' }, { name: 'two' }],
  );
  assert.deepEqual(
    resolveMssqlColumns({
      0: { name: '', column: 'a' },
      1: { name: null, column: null },
    }),
    [{ name: 'a' }, { name: 'column_2' }],
  );
});
