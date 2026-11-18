import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourceDialect } from '@sql-approval/shared';

import {
  POLICY_VERSION,
  SqlPolicyError,
  stripCommentsAndStrings,
  validateReadOnlySql,
} from '../src/policy.js';
import {
  bearer,
  cookieAuth,
  request,
  setupAndUnlock,
  startTestGateway,
  type Authenticated,
  type TestApp,
} from './helpers.js';

/**
 * Every denial below asserts the stable public error code. Passing a dialect
 * exercises the production path (the HTTP call sites always pass the source
 * dialect); omitting it exercises auto detection, which is reserved for tools
 * and tests.
 */
function denialCode(sql: string, dialect?: SourceDialect): string {
  try {
    validateReadOnlySql(sql, dialect);
  } catch (error) {
    assert.ok(error instanceof SqlPolicyError, `expected SqlPolicyError, got ${String(error)}`);
    return error.code;
  }
  assert.fail(`expected ${JSON.stringify(sql)} to be denied`);
}

function expectAllowed(sql: string, dialect?: SourceDialect): void {
  validateReadOnlySql(sql, dialect);
}

function expectDenied(sql: string, code: string, dialect?: SourceDialect): void {
  assert.equal(
    denialCode(sql, dialect),
    code,
    `${JSON.stringify(sql)} [${dialect ?? 'auto'}] should be ${code}`,
  );
}

// ------------------------------------------------------------------ contract

test('policy version is the public sag-policy-1 contract', () => {
  assert.equal(POLICY_VERSION, 'sag-policy-1');
});

test('stripCommentsAndStrings removes comments and literals before keyword checks', () => {
  const stripped = stripCommentsAndStrings("SELECT 'a;b' AS s -- comment ; DROP\nFROM t");
  assert.equal(stripped.unterminated, false);
  assert.equal(stripped.text.includes('a;b'), false);
  assert.equal(stripped.text.toLowerCase().includes('drop'), false);
  assert.equal(/select/i.test(stripped.text), true);
});

test('stripCommentsAndStrings reports unterminated input', () => {
  assert.equal(stripCommentsAndStrings("SELECT 'x").unterminated, true);
  assert.equal(stripCommentsAndStrings('SELECT 1 /* x').unterminated, true);
  assert.equal(stripCommentsAndStrings('SELECT 1 /* x */').unterminated, false);
});

// ------------------------------------------------------------------ positives

test('allows a plain SELECT in every source dialect', () => {
  const dialects: SourceDialect[] = ['mssql', 'sqlite', 'postgres', 'mysql'];
  for (const dialect of dialects) {
    expectAllowed('SELECT 1', dialect);
    expectAllowed('SELECT id, name FROM users WHERE id = 1', dialect);
  }
});

test('allows SELECT without FROM', () => {
  expectAllowed('SELECT 1 + 1 AS two');
  expectAllowed('SELECT CURRENT_TIMESTAMP AS now', 'postgres');
});

test('allows JOINs', () => {
  expectAllowed(
    "SELECT o.id, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'open'",
    'mssql',
  );
  expectAllowed('SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.id', 'mssql');
  expectAllowed('SELECT * FROM t1 CROSS APPLY (SELECT TOP 1 * FROM t2) x', 'mssql');
});

test('allows TOP', () => {
  expectAllowed('SELECT TOP 10 * FROM t ORDER BY id DESC', 'mssql');
  expectAllowed('SELECT TOP (10) PERCENT * FROM t', 'mssql');
});

test('allows LIMIT in sqlite and postgres', () => {
  expectAllowed('SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 5', 'sqlite');
  expectAllowed('SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 5', 'postgres');
});

test('allows a CTE', () => {
  expectAllowed('WITH base AS (SELECT id FROM t) SELECT * FROM base', 'mssql');
});

test('allows multiple CTEs', () => {
  expectAllowed(
    'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT * FROM a, b',
    'mssql',
  );
});

test('allows a recursive CTE', () => {
  expectAllowed(
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10) SELECT x FROM c',
    'sqlite',
  );
});

test('allows UNION ALL', () => {
  expectAllowed('SELECT a FROM t1 UNION ALL SELECT a FROM t2', 'mssql');
  expectAllowed('SELECT a FROM t1 UNION SELECT a FROM t2', 'postgres');
});

test('allows parameter placeholders in the matching dialect', () => {
  expectAllowed('SELECT name FROM items WHERE id = ?', 'sqlite');
  expectAllowed('SELECT name FROM items WHERE id = :id', 'mysql');
  expectAllowed('SELECT name FROM items WHERE id = $1', 'postgres');
  expectAllowed('SELECT * FROM t WHERE id = @id', 'mssql');
});

test('allows a variable in the select list', () => {
  expectAllowed('SELECT @value AS v', 'mssql');
});

test('allows aggregate and scalar function calls', () => {
  expectAllowed(
    'SELECT COUNT(*) AS n, SUM(x) AS s, COALESCE(a, b) AS c FROM t GROUP BY a, b HAVING COUNT(*) > 1',
    'mssql',
  );
  expectAllowed("SELECT LOWER(name) AS n, REPLACE(code, '-', '') AS c FROM t", 'sqlite');
});

test('allows a schema-qualified function call', () => {
  expectAllowed('SELECT dbo.fn_test(1) AS v FROM t', 'mssql');
});

test('rejects table-valued function items in FROM (bare table hints)', () => {
  // `FROM t (NOLOCK)` is parsed as `t(NOLOCK)` by TransactSQL; a table-function
  // shape in FROM is rejected rather than relying on the parser to see a hint.
  expectDenied("SELECT * FROM STRING_SPLIT('a,b', ',')", 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('allows PIVOT', () => {
  expectAllowed('SELECT * FROM t PIVOT (SUM(x) FOR y IN ([a],[b])) AS p', 'mssql');
});

test('allows UNPIVOT', () => {
  expectAllowed('SELECT * FROM t UNPIVOT (v FOR c IN (a,b)) AS u', 'mssql');
});

test('allows schema-qualified tables', () => {
  expectAllowed('SELECT COUNT(*) AS n FROM [dbo].[Orders]', 'mssql');
  expectAllowed('SELECT * FROM dbo.Orders', 'mssql');
  expectAllowed('SELECT * FROM public.users', 'postgres');
});

test('allows quoted identifiers', () => {
  expectAllowed('SELECT [Order Details].[Unit Price] FROM [Order Details]', 'mssql');
  expectAllowed('SELECT `name` FROM `users`', 'mysql');
});

test('allows string literals containing dangerous keywords and semicolons', () => {
  expectAllowed("SELECT 'delete from x; drop table y; exec xp_cmdshell' AS s", 'mssql');
  expectAllowed("SELECT * FROM t WHERE note = 'WITH (NOLOCK)'", 'mssql');
});

test('allows keywords hidden in line comments', () => {
  expectAllowed('SELECT * FROM t -- insert update exec xp_cmdshell\n', 'mssql');
});

test('allows keywords hidden in block comments', () => {
  expectAllowed('SELECT * FROM t /* update t set a=1; delete from t; select 2 */', 'mssql');
  expectAllowed('SELECT /* EXEC xp_cmdshell */ 1', 'mssql');
});

test('allows subqueries and EXISTS', () => {
  expectAllowed('SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)', 'mssql');
  expectAllowed('SELECT (SELECT MAX(x) FROM u) AS m FROM t', 'postgres');
});

test('allows CASE, COALESCE, and window functions', () => {
  expectAllowed(
    'SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END AS c, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn FROM t',
    'mssql',
  );
});

test('allows OFFSET/FETCH', () => {
  expectAllowed(
    'SELECT * FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
    'mssql',
  );
});

test('allows DISTINCT and ORDER BY', () => {
  expectAllowed('SELECT DISTINCT name FROM users ORDER BY name', 'mysql');
});

test('allows IN, BETWEEN, and LIKE predicates', () => {
  expectAllowed('SELECT * FROM t WHERE id IN (1,2,3) AND x BETWEEN 1 AND 10', 'mssql');
  expectAllowed("SELECT * FROM t WHERE name LIKE 'a%'", 'sqlite');
});

test('allows an empty string literal', () => {
  expectAllowed("SELECT '' AS empty", 'mssql');
});

test('allows a trailing semicolon', () => {
  expectAllowed('SELECT 1;', 'mssql');
  expectAllowed('SELECT 1;   ', 'sqlite');
});

test('allows multiline and mixed-case SQL', () => {
  expectAllowed(
    'sElEcT\n  id,\n  name\nfRoM\n  users\nwHeRe\n  id = 1',
    'postgres',
  );
});

test('auto mode accepts the existing sqlite positional-parameter queries', () => {
  // Auto mode remains for tools/tests; HTTP call sites pass the source dialect.
  expectAllowed('SELECT name FROM items WHERE id = ?');
  expectAllowed('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x FROM c');
});

// ------------------------------------------- explicit source dialect (HTTP)

test('explicit mssql rejects lock hints and metadata access', () => {
  expectDenied('SELECT * FROM t WITH (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT @@VERSION', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT * FROM sys.dm_exec_connections', 'METADATA_FORBIDDEN', 'mssql');
});

test('explicit sqlite rejects the sqlite catalog', () => {
  expectDenied('SELECT * FROM sqlite_master', 'METADATA_FORBIDDEN', 'sqlite');
});

test('allows dialect-specific positives when the dialect is explicit', () => {
  expectAllowed('SELECT TOP 1 * FROM t', 'mssql');
  expectAllowed('SELECT * FROM t LIMIT 1', 'sqlite');
  expectAllowed('WITH base AS (SELECT id FROM t) SELECT * FROM base', 'postgres');
  expectAllowed('SELECT 1', 'mysql');
});

test('explicit mssql rejects MySQL-only statements (no auto fallback)', () => {
  // MySQL integer division parses as MySQL but not as TransactSQL. Backtick
  // identifiers are MySQL syntax too; TransactSQL parses them permissively, so
  // the policy rejects them explicitly for mssql. Under the former auto mode
  // (mssql → sqlite → postgres → mysql) both statements passed; with the source
  // dialect explicit they must fail closed.
  for (const sql of ['SELECT `a` FROM t', 'SELECT 1 DIV 2']) {
    expectAllowed(sql, 'mysql');
    expectAllowed(sql); // auto remains available to tools/tests only
    expectDenied(sql, 'POLICY_DENIED', 'mssql');
  }
});

test('explicit mssql rejects MySQL LIMIT syntax', () => {
  expectDenied('SELECT * FROM t LIMIT 1', 'POLICY_DENIED', 'mssql');
  expectDenied('SELECT * FROM t LIMIT 1 OFFSET 5', 'POLICY_DENIED', 'mssql');
  // TOP and OFFSET/FETCH remain the supported mssql row limits.
  expectAllowed('SELECT TOP 1 * FROM t', 'mssql');
  expectAllowed('SELECT * FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 1 ROWS ONLY', 'mssql');
});

// ------------------------------------------------------ HTTP dialect wiring

async function createSource(
  app: TestApp,
  auth: Authenticated,
  dialect: SourceDialect,
): Promise<string> {
  const response = await request(app.url, '/v1/admin/sources', {
    method: 'POST',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
    body: {
      name: `${dialect}-${Math.random().toString(36).slice(2, 10)}`,
      dialect,
    },
  });
  assert.equal(response.status, 201, response.text);
  return String((response.json as Record<string, unknown>).id);
}

test('HTTP submit validates with the source dialect, never auto detection', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const sourceId = await createSource(app, auth, 'mssql');
  // Valid for sqlite/mysql and therefore accepted by the compatibility auto
  // path, but not valid TransactSQL: the source dialect must reject it.
  const sql = 'SELECT name FROM items WHERE id = ?';
  expectAllowed(sql);
  const response = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sourceId, sql },
  });
  assert.equal(response.status, 400, response.text);
  assert.equal((response.json as Record<string, unknown>).code, 'POLICY_DENIED');
});

test('HTTP approval re-checks with the source dialect, never auto detection', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sqliteSource = await createSource(app, auth, 'sqlite');
  const mssqlSource = await createSource(app, auth, 'mssql');

  const created = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sqliteSource, sql: 'SELECT 1 AS one' },
  });
  assert.equal(created.status, 201, created.text);
  const proposalId = String((created.json as Record<string, unknown>).id);

  // Point the pending proposal at an mssql source, as if the source binding had
  // been replaced. Approval must use the current source's dialect; the old auto
  // path would accept this via sqlite.
  app.gateway.store.db
    .prepare('UPDATE proposals SET source_id = ?, sql = ? WHERE id = ?')
    .run(mssqlSource, 'SELECT name FROM items WHERE id = ?', proposalId);

  const approval = await request(app.url, `/v1/admin/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(approval.status, 400, approval.text);
  assert.equal((approval.json as Record<string, unknown>).code, 'POLICY_DENIED');
  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'policy_recheck_failed');
});

test('HTTP approval fails closed when the source is gone', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const sourceId = await createSource(app, auth, 'sqlite');
  const created = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { source_id: sourceId, sql: 'SELECT 1 AS one' },
  });
  assert.equal(created.status, 201, created.text);
  const proposalId = String((created.json as Record<string, unknown>).id);

  const deletion = await request(app.url, `/v1/admin/sources/${sourceId}`, {
    method: 'DELETE',
    headers: cookieAuth(auth.cookie, auth.csrfToken),
  });
  assert.equal(deletion.status, 200, deletion.text);

  const approval = await request(app.url, `/v1/admin/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(approval.status, 404, approval.text);
  assert.equal((approval.json as Record<string, unknown>).code, 'SOURCE_NOT_FOUND');
  const proposal = app.gateway.store.getProposal(proposalId);
  assert.equal(proposal?.status, 'FAILED');
  assert.equal(proposal?.status_message, 'policy_recheck_failed');
});

test('HTTP rejects adversarial bare hints, pragma TVFs, and mssql LIMIT', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app);
  const mssqlSource = await createSource(app, auth, 'mssql');
  const sqliteSource = await createSource(app, auth, 'sqlite');
  const cases: Array<[string, string, string]> = [
    // F-1: bare table hints (previously HTTP 201).
    ['SELECT * FROM t (NOLOCK)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM t (UPDLOCK)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM t (TABLOCKX)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM t (NOLOCK, UPDLOCK)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM dbo.t (NOLOCK)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM t1 JOIN t2 (NOLOCK) ON t1.id = t2.id', 'mssql', 'DANGEROUS_LOCK_HINT'],
    ['SELECT * FROM t1, t2 (NOLOCK)', 'mssql', 'DANGEROUS_LOCK_HINT'],
    // F-2: SQLite pragma virtual tables/functions.
    ["SELECT * FROM pragma_table_info('t')", 'sqlite', 'METADATA_FORBIDDEN'],
    ['SELECT * FROM pragma_database_list', 'sqlite', 'METADATA_FORBIDDEN'],
    ['SELECT * FROM pragma_table_list', 'sqlite', 'METADATA_FORBIDDEN'],
    ['SELECT * FROM pragma_index_list', 'sqlite', 'METADATA_FORBIDDEN'],
    // F-3: mssql must not accept MySQL LIMIT.
    ['SELECT * FROM t LIMIT 1', 'mssql', 'POLICY_DENIED'],
    ['SELECT * FROM t LIMIT 1 OFFSET 5', 'mssql', 'POLICY_DENIED'],
  ];
  for (const [sql, dialect, expectedCode] of cases) {
    const response = await request(app.url, '/v1/agent/proposals', {
      method: 'POST',
      headers: bearer(auth.agentToken),
      body: {
        source_id: dialect === 'mssql' ? mssqlSource : sqliteSource,
        sql,
      },
    });
    assert.equal(response.status, 400, `${sql}: ${response.text}`);
    assert.equal(
      (response.json as Record<string, unknown>).code,
      expectedCode,
      `${sql}: ${response.text}`,
    );
  }
});

// ------------------------------------------------------- structural negatives

test('rejects empty input', () => {
  expectDenied('', 'EMPTY_SQL');
  expectDenied('   ', 'EMPTY_SQL');
  expectDenied('-- only comment', 'EMPTY_SQL');
  expectDenied('/* only comment */', 'EMPTY_SQL');
  expectDenied(123 as unknown as string, 'EMPTY_SQL');
});

test('rejects over-long SQL', () => {
  expectDenied('SELECT 1'.repeat(40_000), 'SQL_TOO_LONG');
});

test('rejects unterminated strings and comments as POLICY_DENIED', () => {
  expectDenied("SELECT 'abc", 'POLICY_DENIED', 'mssql');
  expectDenied('SELECT 1 /* abc', 'POLICY_DENIED', 'mssql');
});

test('rejects multiple statements', () => {
  expectDenied('SELECT 1; DROP TABLE x', 'MULTI_STATEMENT');
  expectDenied('SELECT 1;\nSELECT 2', 'MULTI_STATEMENT');
  expectDenied('SELECT 1 /* ; */; DROP TABLE x', 'MULTI_STATEMENT');
});

test('rejects INSERT', () => {
  expectDenied('INSERT INTO t VALUES (1)', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('insert\ninto t\nvalues (1)', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects UPDATE', () => {
  expectDenied('UPDATE t SET a = 1', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('/* lead */ update t set a = 1', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects DELETE', () => {
  expectDenied('DELETE FROM t', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('delete from t where id = 1', 'FORBIDDEN_STATEMENT', 'sqlite');
});

test('rejects MERGE', () => {
  expectDenied(
    'MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE',
    'FORBIDDEN_STATEMENT',
    'mssql',
  );
});

test('rejects TRUNCATE', () => {
  expectDenied('TRUNCATE TABLE t', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('truncate t', 'FORBIDDEN_STATEMENT', 'mysql');
});

test('rejects EXEC and EXECUTE', () => {
  expectDenied('EXEC sp_who', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('EXECUTE dbo.proc', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('exec sp_who', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects CALL', () => {
  expectDenied('CALL p()', 'FORBIDDEN_STATEMENT', 'mysql');
  expectDenied('call p(1)', 'FORBIDDEN_STATEMENT', 'postgres');
});

test('rejects DDL', () => {
  expectDenied('CREATE TABLE t (a int)', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('DROP TABLE t', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('ALTER TABLE t ADD b int', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('REINDEX TABLE t', 'FORBIDDEN_STATEMENT', 'postgres');
});

test('rejects GRANT, REVOKE, and DENY', () => {
  expectDenied('GRANT SELECT ON t TO public', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('REVOKE SELECT ON t FROM public', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('DENY SELECT ON t TO public', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects ATTACH, PRAGMA, and VACUUM', () => {
  expectDenied("ATTACH DATABASE 'x.db' AS x", 'FORBIDDEN_STATEMENT', 'sqlite');
  expectDenied('PRAGMA table_info(t)', 'FORBIDDEN_STATEMENT', 'sqlite');
  expectDenied('VACUUM', 'FORBIDDEN_STATEMENT', 'sqlite');
});

test('rejects a CTE whose body is a data-changing statement', () => {
  expectDenied('WITH a AS (SELECT 1) DELETE FROM t', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects non-SELECT control statements as NOT_SELECT', () => {
  expectDenied('SET NOCOUNT ON', 'NOT_SELECT', 'mssql');
  expectDenied('USE master', 'NOT_SELECT', 'mssql');
});

test('rejects SELECT INTO', () => {
  expectDenied('SELECT * INTO new_t FROM t', 'SELECT_INTO', 'mssql');
  expectDenied('select * into [new t] from t', 'SELECT_INTO', 'mssql');
  expectDenied('SELECT *\n  INTO\n  new_t\nFROM t', 'SELECT_INTO', 'mssql');
});

test('rejects temporary tables', () => {
  expectDenied('SELECT * FROM #tmp', 'TEMP_OBJECT', 'mssql');
  expectDenied('SELECT * FROM ##global_tmp', 'TEMP_OBJECT', 'mssql');
  expectDenied('SELECT * FROM [#tmp]', 'TEMP_OBJECT', 'mssql');
  expectDenied('select * from #Tmp t', 'TEMP_OBJECT', 'mssql');
});

test('rejects table variables', () => {
  expectDenied('SELECT * FROM @tv', 'TEMP_OBJECT', 'mssql');
  expectDenied('SELECT * FROM t JOIN @tv v ON 1=1', 'TEMP_OBJECT', 'mssql');
});

test('rejects lock hints', () => {
  expectDenied('SELECT * FROM t WITH (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('sElEcT * FrOm t WiTh (NoLock)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT * FROM t WITH (UPDLOCK, ROWLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT * FROM t WITH (TABLOCKX)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT * FROM t WITH (READPAST)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

// Adversarial F-1: bare table hints are parsed as table-valued functions by
// TransactSQL (`t (NOLOCK)` -> `t(NOLOCK)`). All seven shapes must deny with
// the same lock-hint error code.

test('rejects bare NOLOCK table hint', () => {
  expectDenied('SELECT * FROM t (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects bare UPDLOCK table hint', () => {
  expectDenied('SELECT * FROM t (UPDLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects bare TABLOCKX table hint', () => {
  expectDenied('SELECT * FROM t (TABLOCKX)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects multiple bare table hints', () => {
  expectDenied('SELECT * FROM t (NOLOCK, UPDLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects a schema-qualified bare table hint', () => {
  expectDenied('SELECT * FROM dbo.t (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects a bare table hint on a JOIN item', () => {
  expectDenied(
    'SELECT * FROM t1 JOIN t2 (NOLOCK) ON t1.id = t2.id',
    'DANGEROUS_LOCK_HINT',
    'mssql',
  );
});

test('rejects a bare table hint on a comma-separated FROM item', () => {
  expectDenied('SELECT * FROM t1, t2 (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects OPTION query hints', () => {
  expectDenied('SELECT * FROM t OPTION (RECOMPILE)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('select * from t option(maxdop 1)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects FOR XML and FOR JSON', () => {
  expectDenied('SELECT * FROM t FOR XML PATH', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT * FROM t FOR JSON PATH', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('select * from t for xml path', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects MySQL locking reads', () => {
  expectDenied('SELECT * FROM t LOCK IN SHARE MODE', 'DANGEROUS_LOCK_HINT', 'mysql');
});

test('rejects three-part cross-database names', () => {
  expectDenied('SELECT * FROM db1.dbo.t', 'CROSS_DATABASE', 'mssql');
  expectDenied('SELECT * FROM [db1].[dbo].[t]', 'CROSS_DATABASE', 'mssql');
  expectDenied('SELECT *\nFROM db1\n  .dbo\n  .t', 'CROSS_DATABASE', 'mssql');
  expectDenied('SELECT DB1.DBO.T.C FROM DB1.DBO.T', 'CROSS_DATABASE', 'mssql');
});

test('rejects four-part / server-qualified names', () => {
  expectDenied('SELECT * FROM server1.db1.dbo.t', 'CROSS_DATABASE', 'mssql');
  expectDenied('SELECT * FROM [server1].[db1].[dbo].[t]', 'CROSS_DATABASE', 'mssql');
});

test('rejects OPENROWSET', () => {
  expectDenied(
    'SELECT * FROM OPENROWSET(BULK 1, SINGLE_CLOB) AS x',
    'EXTERNAL_SOURCE',
    'mssql',
  );
  expectDenied("SELECT * FROM openrowset('SQLNCLI', 'x', 'SELECT 1')", 'EXTERNAL_SOURCE', 'mssql');
});

test('rejects OPENQUERY, OPENDATASOURCE, and OPENXML', () => {
  expectDenied("SELECT * FROM OPENQUERY(linked, 'SELECT 1')", 'EXTERNAL_SOURCE', 'mssql');
  expectDenied(
    "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'x').db.dbo.t",
    'EXTERNAL_SOURCE',
    'mssql',
  );
  expectDenied("SELECT * FROM OPENXML(1, '/x')", 'EXTERNAL_SOURCE', 'mssql');
});

test('rejects sp_ and xp_ procedures', () => {
  expectDenied('EXEC sp_who', 'FORBIDDEN_STATEMENT', 'mssql');
  expectDenied("SELECT * FROM xp_cmdshell('dir')", 'EXTERNAL_SOURCE', 'mssql');
  expectDenied('EXEC xp_cmdshell', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('rejects @@ metadata variables', () => {
  expectDenied('SELECT @@SERVERNAME', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT @@VERSION', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT @@SPID', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects DB_NAME and SUSER_SNAME', () => {
  expectDenied('SELECT DB_NAME()', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT SUSER_SNAME()', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT suser_sid()', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects HOST_NAME, OBJECT_NAME, and SCHEMA_NAME', () => {
  expectDenied('SELECT HOST_NAME()', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT OBJECT_NAME(1)', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT SCHEMA_NAME()', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT SCHEMA_ID()', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects other server-metadata functions', () => {
  expectDenied('SELECT USER_NAME()', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT SERVERPROPERTY(\'Edition\')', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT current_database()', 'METADATA_FORBIDDEN', 'postgres');
  expectDenied('SELECT version()', 'METADATA_FORBIDDEN', 'mysql');
  expectDenied('SELECT sqlite_version()', 'METADATA_FORBIDDEN', 'sqlite');
});

test('rejects bare CURRENT_USER / SESSION_USER as metadata', () => {
  expectDenied('SELECT CURRENT_USER', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT current_user', 'METADATA_FORBIDDEN', 'postgres');
  expectDenied('SELECT SESSION_USER', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects sys.* catalog access', () => {
  expectDenied('SELECT * FROM sys.tables', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT * FROM [sys].[tables]', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT * FROM SYS.TABLES', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects DMVs', () => {
  expectDenied('SELECT * FROM sys.dm_exec_requests', 'METADATA_FORBIDDEN', 'mssql');
  expectDenied('SELECT * FROM sys.dm_exec_sessions', 'METADATA_FORBIDDEN', 'mssql');
});

test('rejects information_schema access', () => {
  expectDenied('SELECT * FROM information_schema.tables', 'METADATA_FORBIDDEN', 'postgres');
  expectDenied('SELECT * FROM INFORMATION_SCHEMA.COLUMNS', 'METADATA_FORBIDDEN', 'mysql');
});

test('rejects pg_catalog access', () => {
  expectDenied('SELECT * FROM pg_catalog.pg_tables', 'METADATA_FORBIDDEN', 'postgres');
  expectDenied('SELECT * FROM "pg_catalog"."pg_tables"', 'METADATA_FORBIDDEN', 'postgres');
});

test('rejects sqlite system catalogs', () => {
  expectDenied('SELECT * FROM sqlite_master', 'METADATA_FORBIDDEN', 'sqlite');
  expectDenied('SELECT * FROM sqlite_schema', 'METADATA_FORBIDDEN', 'sqlite');
  expectDenied('SELECT * FROM sqlite_temp_master', 'METADATA_FORBIDDEN', 'sqlite');
  expectDenied('SELECT * FROM sqlite_sequence', 'METADATA_FORBIDDEN', 'sqlite');
  expectDenied('SELECT * FROM main.sqlite_sequence', 'METADATA_FORBIDDEN', 'sqlite');
});

// Adversarial F-2: SQLite pragma virtual tables/table-valued functions.
test('rejects pragma_table_info', () => {
  expectDenied("SELECT * FROM pragma_table_info('t')", 'METADATA_FORBIDDEN', 'sqlite');
});

test('rejects pragma_database_list', () => {
  expectDenied('SELECT * FROM pragma_database_list', 'METADATA_FORBIDDEN', 'sqlite');
});

test('rejects pragma_table_list', () => {
  expectDenied('SELECT * FROM pragma_table_list', 'METADATA_FORBIDDEN', 'sqlite');
});

test('rejects pragma_index_list', () => {
  expectDenied('SELECT * FROM pragma_index_list', 'METADATA_FORBIDDEN', 'sqlite');
});

// --------------------------------------------------------------- obfuscation

test('rejects case and whitespace variants of forbidden constructs', () => {
  expectDenied('sElEcT * fRoM t WiTh (NoLock)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT *\nFROM t\nWITH\n\t(NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
  expectDenied('SELECT\t*\r\nFROM\r\n#tmp', 'TEMP_OBJECT', 'mssql');
});

test('rejects an ideographic space before a lock hint', () => {
  expectDenied('SELECT * FROM t\u3000WITH (NOLOCK)', 'DANGEROUS_LOCK_HINT', 'mssql');
});

test('rejects a full-width keyword spelling', () => {
  expectDenied('ＳＥＬＥＣＴ 1', 'NOT_SELECT');
  expectDenied('ＳＥＬＥＣＴ * FROM t', 'NOT_SELECT');
});

test('does not treat comments as executable text', () => {
  // Comments are stripped before the keyword guard, so they must not deny...
  expectAllowed('SELECT 1 /* ; DROP TABLE x; EXEC xp_cmdshell */', 'mssql');
  // ...but they also cannot hide a real statement after the comment.
  expectDenied('/* harmless */ DROP TABLE x', 'FORBIDDEN_STATEMENT', 'mssql');
});

test('fails closed when the parser cannot verify a SELECT', () => {
  expectDenied('SELECT * FROM', 'POLICY_DENIED', 'mssql');
  expectDenied('SELECT (((', 'POLICY_DENIED', 'mssql');
  expectDenied('SELECT * FROM t WHERE', 'POLICY_DENIED', 'mssql');
  expectDenied('SELECT 1 +', 'POLICY_DENIED', 'mssql');
});

test('fails closed when stripping comments splits a keyword', () => {
  // `SEL/*x*/ECT` is not a legal SELECT after comment removal; deny, never allow.
  expectDenied('SEL/*x*/ECT 1', 'NOT_SELECT', 'mssql');
});

test('rejects a MySQL cross-database two-part name (stricter than bare three-part)', () => {
  expectDenied('SELECT * FROM mydb.users', 'CROSS_DATABASE', 'mysql');
});

test('rejects the sqlite temp schema as a temporary object', () => {
  expectDenied('SELECT * FROM temp.users', 'TEMP_OBJECT', 'sqlite');
});

// -------------------------------------------------------- known limitations

test(
  'KNOWN LIMITATION: TRY_CAST is legal T-SQL but node-sql-parser 5.4.0 cannot parse it',
  { skip: 'node-sql-parser limitation; policy keeps fail-closed POLICY_DENIED, never allows it' },
  () => {
    // Documented instead of loosened: this read-only T-SQL is rejected with
    // POLICY_DENIED because the AST cannot be verified.
    expectDenied('SELECT TRY_CAST(x AS int) FROM t', 'POLICY_DENIED', 'mssql');
  },
);

test(
  'KNOWN LIMITATION: TABLESAMPLE is legal T-SQL but node-sql-parser 5.4.0 cannot parse it',
  { skip: 'node-sql-parser limitation; policy keeps fail-closed POLICY_DENIED, never allows it' },
  () => {
    expectDenied('SELECT * FROM t TABLESAMPLE (10 PERCENT)', 'POLICY_DENIED', 'mssql');
  },
);

test(
  'KNOWN LIMITATION: GROUP BY ROLLUP is legal T-SQL but node-sql-parser 5.4.0 cannot parse it',
  { skip: 'node-sql-parser limitation; policy keeps fail-closed POLICY_DENIED, never allows it' },
  () => {
    expectDenied('SELECT a, b FROM t GROUP BY ROLLUP(a, b)', 'POLICY_DENIED', 'mssql');
  },
);
