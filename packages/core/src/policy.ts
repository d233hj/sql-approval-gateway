import {
  SQL_MAX_LENGTH,
  type ErrorCode,
  type SourceDialect,
} from '@sql-approval/shared';
import sqlParser from 'node-sql-parser';

export { POLICY_VERSION } from '@sql-approval/shared';

export class SqlPolicyError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SqlPolicyError';
    this.code = code;
  }
}

interface StrippedSql {
  text: string;
  unterminated: boolean;
}

/**
 * Replaces comments and string literals with spaces/empty literals so keyword
 * checks cannot be fooled by content inside a literal. This is deliberately
 * conservative: any spelling that the checks cannot classify is rejected by the
 * caller.
 */
export function stripCommentsAndStrings(sql: string): StrippedSql {
  let output = '';
  let index = 0;
  let unterminated = false;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      output += ' ';
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) {
        unterminated = true;
        output += ' ';
        break;
      }
      output += ' ';
      index = end + 2;
      continue;
    }

    if (char === "'") {
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) unterminated = true;
      output += "''";
      continue;
    }

    output += char;
    index += 1;
  }

  return { text: output, unterminated };
}

// --------------------------------------------------------------------- parser

const { Parser } = sqlParser;

/** node-sql-parser database names, keyed by the gateway's source dialect. */
const PARSER_DATABASE: Record<SourceDialect, string> = {
  mssql: 'TransactSQL',
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
};

/**
 * Auto mode is a compatibility helper for tools and tests only. HTTP proposal
 * paths MUST pass the source dialect explicitly: trying every dialect would let
 * a statement that is illegal on the selected source pass merely because some
 * other dialect can parse it. The keyword guard runs before this and is
 * dialect-independent.
 */
const AUTO_DIALECTS: readonly SourceDialect[] = ['mssql', 'sqlite', 'postgres', 'mysql'];

let parser: InstanceType<typeof Parser> | undefined;

function getParser(): InstanceType<typeof Parser> {
  parser ??= new Parser();
  return parser;
}

/** Optional second argument of {@link validateReadOnlySql}. */
export interface PolicyValidationOptions {
  /**
   * Source dialect. HTTP call sites MUST pass it; omitting it enables auto
   * detection, which is intended for tools and tests only.
   */
  dialect?: SourceDialect;
}

function resolveDialect(input: SourceDialect | PolicyValidationOptions | undefined): SourceDialect | undefined {
  if (input === undefined) return undefined;
  const candidate = typeof input === 'string' ? input : input.dialect;
  if (candidate === undefined) return undefined;
  if (!(candidate in PARSER_DATABASE)) {
    throw new SqlPolicyError('POLICY_DENIED', 'Unknown SQL dialect');
  }
  return candidate;
}

// -------------------------------------------------------------- keyword guard

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|merge|drop|create|alter|truncate|exec|execute|grant|revoke|deny|backup|restore|declare|call|attach|detach|vacuum|pragma|analyze|reindex|dbcc|shutdown|reconfigure|waitfor|impersonate|setuser)\b/i;

const REPLACE_INTO = /\breplace\s+into\b/i;

const LOCK_HINT =
  /\bwith\s*\(\s*(nolock|readpast|updlock|rowlock|paglock|tablockx?|holdlock|serializable|readcommitted|readuncommitted|nowait|noexpand|index|forceseek|forcescan|spatial_window_max_cells)\b/i;

const QUERY_OPTION = /\boption\s*\(/i;

const SERIALIZATION_CLAUSE = /\bfor\s+(xml|json|update|share|browse|key\s+share|no\s+key\s+update)\b/i;

const LOCK_IN_SHARE_MODE = /\block\s+in\s+share\s+mode\b/i;

const TEMP_TABLE_NAME = /#\w+/;

const TABLE_VARIABLE = /\b(?:from|join|apply|into)\s+@[A-Za-z_][\w$]*/i;

const EXTERNAL_SOURCE =
  /\b(openrowset|openquery|opendatasource|openxml)\b/i;

const SYSTEM_PROCEDURE = /\b(?:sp|xp)_\w+/i;

const SERVER_METADATA_VARIABLE = /@@/;

// CURRENT_USER/SESSION_USER/SYSTEM_USER are keywords, not function calls, so
// the function-name guard below does not see them.
const CURRENT_USER_KEYWORD = /\b(?:current_user|session_user|system_user)\b/i;

const PRAGMA_FUNCTION_OR_TABLE = /\bpragma_[A-Za-z0-9_]*\b/i;

const METADATA_FUNCTION =
  /\b(db_name|db_id|suser_sname|suser_sid|host_name|object_name|object_id|schema_name|schema_id|user_name|user_id|system_user|session_user|current_user|serverproperty|col_name|col_length|index_col|indexkey_property|file_name|file_id|databasepropertyex|has_perms_by_name|is_member|is_srvrolemember|loginproperty|current_database|current_schema|current_schemas|current_setting|set_config|version|database|connection_id|pg_backend_pid|pg_postmaster_start_time|pg_conf_load_time|pg_is_in_recovery|pg_read_file|pg_ls_dir|pg_stat_file|inet_server_addr|inet_server_port|sqlite_version|sqlite_source_id|sqlite_compileoption_get|sqlite_compileoption_used)\s*\(/i;

// Boundary-aware so identifiers such as `mysys.t` are not treated as `sys.t`.
// Optional brackets catch `[sys].[objects]` / `[information_schema].[tables]`.
const SYSTEM_CATALOG =
  /(?:^|[^\w$])\[?\s*(sys|information_schema|pg_catalog|mysql|performance_schema)\s*\]?\s*\./i;

const SQLITE_CATALOG = /\bsqlite_(master|schema|temp_master|temp_schema)\b/i;

// Any sqlite_* table reference is internal SQLite state (sqlite_sequence,
// sqlite_stat1, ...). Restrict the guard to FROM/JOIN so a column alias is not
// misclassified.
const SQLITE_FROM_PREFIX =
  /(?:^|[^\w$])(?:from|join)\s+(?:(?:\[[^\]\r\n]+\]|[A-Za-z_][\w$]*)\s*\.\s*)?sqlite_[A-Za-z0-9_]*/i;

// TransactSQL accepts `FROM t (NOLOCK)` as a table-valued function call
// `t(NOLOCK)`. This guard rejects a parenthesised FROM/JOIN item before the
// parser gets a chance to reinterpret it; comma-separated items are covered by
// the AST guard as well.
const TABLE_FUNCTION_FROM =
  /(?:^|[^\w$])(?:from|join)\s+(?:\[[^\]\r\n]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:\[[^\]\r\n]+\]|[A-Za-z_][\w$]*))*\s*\(/i;

const BARE_TRIPLE_NAME = /\b[A-Za-z_][\w$]*\s*\.\s*[A-Za-z_][\w$]*\s*\.\s*[A-Za-z_][\w$]*\b/;

const BRACKET_TRIPLE_NAME = /\[[^\]\r\n]+\]\s*\.\s*\[[^\]\r\n]+\]\s*\.\s*\[[^\]\r\n]+\]/;

// ----------------------------------------------------------------- AST guard

const DANGEROUS_AST_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'merge',
  'create',
  'drop',
  'alter',
  'truncate',
  'exec',
  'execute',
  'call',
  'grant',
  'revoke',
  'deny',
  'backup',
  'restore',
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'analyze',
]);

const SYSTEM_SCHEMAS = new Set([
  'sys',
  'information_schema',
  'pg_catalog',
  // MySQL system databases are not named in DESIGN §7.1, but denying them is
  // the same fail-closed stance as the listed catalogs.
  'mysql',
  'performance_schema',
]);

const DENIED_FUNCTIONS = new Set([
  'db_name',
  'db_id',
  'suser_sname',
  'suser_sid',
  'host_name',
  'object_name',
  'object_id',
  'schema_name',
  'schema_id',
  'user_name',
  'user_id',
  'system_user',
  'session_user',
  'current_user',
  'serverproperty',
  'col_name',
  'col_length',
  'index_col',
  'indexkey_property',
  'file_name',
  'file_id',
  'databasepropertyex',
  'has_perms_by_name',
  'is_member',
  'is_srvrolemember',
  'loginproperty',
  'current_database',
  'current_schema',
  'current_schemas',
  'current_setting',
  'set_config',
  'version',
  'database',
  'connection_id',
  'pg_backend_pid',
  'pg_postmaster_start_time',
  'pg_conf_load_time',
  'pg_is_in_recovery',
  'pg_read_file',
  'pg_ls_dir',
  'pg_stat_file',
  'inet_server_addr',
  'inet_server_port',
  'sqlite_version',
  'sqlite_source_id',
  'sqlite_compileoption_get',
  'sqlite_compileoption_used',
]);

const EXTERNAL_FUNCTIONS = new Set([
  'openrowset',
  'openquery',
  'opendatasource',
  'openxml',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function lower(value: unknown): string {
  return asText(value).toLowerCase();
}

function functionNameParts(node: Record<string, unknown>): string[] {
  const raw = node.name;
  if (typeof raw === 'string') return [raw];
  if (!isRecord(raw)) return [];
  const inner = raw.name;
  if (typeof inner === 'string') return [inner];
  if (!Array.isArray(inner)) return [];
  return inner.flatMap((part) =>
    isRecord(part) && typeof part.value === 'string' ? [part.value] : [],
  );
}

function checkFunctionName(rawName: string): void {
  const name = rawName.replace(/^[\["`]|[\]"`]$/g, '').toLowerCase();
  if (name.startsWith('pragma_') || DENIED_FUNCTIONS.has(name)) {
    throw new SqlPolicyError('METADATA_FORBIDDEN', 'Server metadata access is not allowed');
  }
  if (name.startsWith('sp_') || name.startsWith('xp_')) {
    throw new SqlPolicyError('EXTERNAL_SOURCE', 'External data sources are not allowed');
  }
  if (EXTERNAL_FUNCTIONS.has(name)) {
    throw new SqlPolicyError('EXTERNAL_SOURCE', 'External data sources are not allowed');
  }
}

function checkTableReference(node: Record<string, unknown>, dialect: SourceDialect): void {
  const table = lower(node.table);
  if (table.length === 0) return;

  if (table.startsWith('#') || table.startsWith('@')) {
    throw new SqlPolicyError('TEMP_OBJECT', 'Temporary objects are not allowed');
  }

  const db = lower(node.db);
  const schema = lower(node.schema);
  const server = lower(node.server);

  if (server.length > 0) {
    throw new SqlPolicyError('CROSS_DATABASE', 'Cross-database names are not allowed');
  }
  if (SYSTEM_SCHEMAS.has(db) || SYSTEM_SCHEMAS.has(schema)) {
    throw new SqlPolicyError('METADATA_FORBIDDEN', 'System catalogs are not allowed');
  }
  if (table.startsWith('sqlite_') || table.startsWith('pragma_')) {
    throw new SqlPolicyError('METADATA_FORBIDDEN', 'System catalogs are not allowed');
  }
  if (dialect === 'sqlite' && db === 'temp') {
    throw new SqlPolicyError('TEMP_OBJECT', 'Temporary objects are not allowed');
  }

  // Three-part names (db.schema.table) and any server-qualified name are
  // cross-database. A two-part name is schema.table for mssql/postgres/sqlite,
  // but database.table for MySQL, which is also cross-database there.
  if (schema.length > 0) {
    throw new SqlPolicyError('CROSS_DATABASE', 'Cross-database names are not allowed');
  }
  if (dialect === 'mysql' && db.length > 0) {
    throw new SqlPolicyError('CROSS_DATABASE', 'Cross-database names are not allowed');
  }
}

function checkColumnReference(node: Record<string, unknown>): void {
  const server = lower(node.server);
  const db = lower(node.db);
  const schema = lower(node.schema);
  if (server.length > 0 || (db.length > 0 && schema.length > 0)) {
    throw new SqlPolicyError('CROSS_DATABASE', 'Cross-database names are not allowed');
  }
}

function checkSelectNode(node: Record<string, unknown>): void {
  const into = node.into;
  if (into != null && (!isRecord(into) || into.expr != null || into.type === 'into')) {
    throw new SqlPolicyError('SELECT_INTO', 'SELECT INTO is not allowed');
  }
  if (node.for != null || node.options != null || node.locking_read != null || node.for_update != null) {
    throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
  }
}

function checkFromItems(node: Record<string, unknown>): void {
  const from = node.from;
  if (!Array.isArray(from)) return;
  for (const item of from) {
    if (!isRecord(item)) continue;
    // `FROM t (NOLOCK)` / `JOIN t2 (NOLOCK)` parse as function table items. A
    // table-valued function in FROM is rejected too: table hints are the only
    // reason a bare `name (...)` can appear there in agent SQL.
    if (lower(item.type) === 'function') {
      throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
    }
    if (isRecord(item.expr) && lower(item.expr.type) === 'function') {
      throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
    }
  }
}

function inspectAst(node: unknown, dialect: SourceDialect, depth: number): void {
  if (depth > 200) {
    throw new SqlPolicyError('POLICY_DENIED', 'SQL nesting is too deep');
  }
  if (Array.isArray(node)) {
    for (const item of node) inspectAst(item, dialect, depth + 1);
    return;
  }
  if (!isRecord(node)) return;

  const type = lower(node.type);
  if (DANGEROUS_AST_TYPES.has(type)) {
    throw new SqlPolicyError('FORBIDDEN_STATEMENT', 'Statement contains a forbidden operation');
  }

  if (type === 'function') {
    const parts = functionNameParts(node);
    if (parts.length === 0) {
      throw new SqlPolicyError('POLICY_DENIED', 'Unable to verify a function call');
    }
    for (const part of parts) checkFunctionName(part);
  }
  if (type === 'aggr_func' && typeof node.name === 'string') {
    checkFunctionName(node.name);
  }
  if (type === 'select') {
    checkSelectNode(node);
    checkFromItems(node);
  }
  if (node.table_hint != null) {
    throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
  }
  if (typeof node.table === 'string' && type !== 'column_ref') {
    checkTableReference(node, dialect);
  }
  if (type === 'column_ref') {
    checkColumnReference(node);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'tableList' || key === 'columnList') continue;
    if (typeof value === 'object' && value !== null) {
      inspectAst(value, dialect, depth + 1);
    }
  }
}

function parseAndValidate(sql: string, dialect: SourceDialect): void {
  let parsed: unknown;
  try {
    parsed = getParser().astify(sql, { database: PARSER_DATABASE[dialect] });
  } catch {
    throw new SqlPolicyError('POLICY_DENIED', `SQL could not be parsed as ${dialect}`);
  }

  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length === 0) {
    throw new SqlPolicyError('POLICY_DENIED', 'SQL could not be parsed');
  }
  if (statements.length > 1) {
    throw new SqlPolicyError('MULTI_STATEMENT', 'Only one SQL statement is allowed');
  }

  const root = statements[0];
  if (!isRecord(root)) {
    throw new SqlPolicyError('POLICY_DENIED', 'SQL could not be parsed');
  }
  const rootType = lower(root.type);
  if (rootType !== 'select') {
    if (DANGEROUS_AST_TYPES.has(rootType)) {
      throw new SqlPolicyError('FORBIDDEN_STATEMENT', 'Only SELECT statements are allowed');
    }
    throw new SqlPolicyError('NOT_SELECT', 'Only SELECT statements are allowed');
  }

  inspectAst(root, dialect, 0);
}

// ------------------------------------------------------------------- public

/**
 * Validates that `sql` is exactly one read-only SELECT / WITH ... SELECT.
 *
 * The keyword guard runs on comment- and string-stripped text first (so hidden
 * keywords cannot slip through and harmless literals cannot trigger it); the
 * AST rules are the second line of defence. Anything the parser cannot verify
 * is denied (`POLICY_DENIED`), never allowed.
 *
 * @param dialectOrOptions source dialect (`mssql`, `sqlite`, `postgres`,
 *   `mysql`) or an options object. HTTP call sites MUST pass the source
 *   dialect explicitly; omitting it enables auto dialect detection, which is
 *   intended for tools and tests only.
 */
export function validateReadOnlySql(
  sql: string,
  dialectOrOptions?: SourceDialect | PolicyValidationOptions,
): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new SqlPolicyError('EMPTY_SQL', 'SQL must not be empty');
  }
  if (sql.length > SQL_MAX_LENGTH) {
    throw new SqlPolicyError('SQL_TOO_LONG', 'SQL exceeds the maximum length');
  }

  const dialect = resolveDialect(dialectOrOptions);

  const { text, unterminated } = stripCommentsAndStrings(sql);
  if (unterminated) {
    throw new SqlPolicyError('POLICY_DENIED', 'SQL contains an unterminated comment or string');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new SqlPolicyError('EMPTY_SQL', 'SQL must not be empty');
  }

  const parts = trimmed.split(';').filter((part) => part.trim().length > 0);
  if (parts.length > 1) {
    throw new SqlPolicyError('MULTI_STATEMENT', 'Only one SQL statement is allowed');
  }
  const statement = (parts[0] ?? '').trim();
  const startsWithSelect = /^(select|with)\b/i.test(statement);
  const hasForbiddenKeyword = FORBIDDEN_KEYWORDS.test(statement) || REPLACE_INTO.test(statement);

  if (!startsWithSelect) {
    if (hasForbiddenKeyword) {
      throw new SqlPolicyError('FORBIDDEN_STATEMENT', 'Statement contains a forbidden keyword');
    }
    throw new SqlPolicyError('NOT_SELECT', 'Only SELECT statements are allowed');
  }
  if (hasForbiddenKeyword) {
    throw new SqlPolicyError('FORBIDDEN_STATEMENT', 'Statement contains a forbidden keyword');
  }
  if (/^with\b/i.test(statement) && !/\bselect\b/i.test(statement.slice(4))) {
    throw new SqlPolicyError('NOT_SELECT', 'WITH must contain a SELECT statement');
  }

  if (/\binto\b/i.test(statement)) {
    throw new SqlPolicyError('SELECT_INTO', 'SELECT INTO is not allowed');
  }
  if (
    LOCK_HINT.test(statement) ||
    QUERY_OPTION.test(statement) ||
    SERIALIZATION_CLAUSE.test(statement) ||
    LOCK_IN_SHARE_MODE.test(statement)
  ) {
    throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
  }
  if (TEMP_TABLE_NAME.test(statement) || TABLE_VARIABLE.test(statement)) {
    throw new SqlPolicyError('TEMP_OBJECT', 'Temporary objects are not allowed');
  }
  if (EXTERNAL_SOURCE.test(statement) || SYSTEM_PROCEDURE.test(statement)) {
    throw new SqlPolicyError('EXTERNAL_SOURCE', 'External data sources are not allowed');
  }
  if (
    SERVER_METADATA_VARIABLE.test(statement) ||
    CURRENT_USER_KEYWORD.test(statement) ||
    PRAGMA_FUNCTION_OR_TABLE.test(statement) ||
    METADATA_FUNCTION.test(statement)
  ) {
    throw new SqlPolicyError('METADATA_FORBIDDEN', 'Server metadata access is not allowed');
  }
  if (
    SYSTEM_CATALOG.test(statement) ||
    SQLITE_CATALOG.test(statement) ||
    SQLITE_FROM_PREFIX.test(statement)
  ) {
    throw new SqlPolicyError('METADATA_FORBIDDEN', 'System catalogs are not allowed');
  }
  if (TABLE_FUNCTION_FROM.test(statement)) {
    throw new SqlPolicyError('DANGEROUS_LOCK_HINT', 'Lock hints and query options are not allowed');
  }
  if (BARE_TRIPLE_NAME.test(statement) || BRACKET_TRIPLE_NAME.test(statement)) {
    throw new SqlPolicyError('CROSS_DATABASE', 'Cross-database names are not allowed');
  }

  // TransactSQL's parser is permissive about MySQL's LIMIT clause. SQL Server
  // uses TOP or OFFSET ... FETCH, so reject LIMIT explicitly for mssql sources.
  if (dialect === 'mssql' && /\blimit\b/i.test(statement)) {
    throw new SqlPolicyError('POLICY_DENIED', 'LIMIT is not supported for the mssql dialect');
  }

  // Backtick-quoted identifiers are MySQL syntax (SQLite accepts them for
  // compatibility), but node-sql-parser's TransactSQL/PostgreSQL grammars also
  // parse them permissively. Reject them explicitly for those source dialects
  // instead of relying on the parser.
  if ((dialect === 'mssql' || dialect === 'postgres') && statement.includes('`')) {
    throw new SqlPolicyError(
      'POLICY_DENIED',
      `Backtick-quoted identifiers are not supported for ${dialect}`,
    );
  }

  if (dialect !== undefined) {
    parseAndValidate(sql, dialect);
    return;
  }

  // Auto mode (tools/tests only): keep the most specific failure from the first
  // dialect so callers see a stable code, but accept only if a parse passes
  // every rule.
  let firstError: SqlPolicyError | undefined;
  for (const candidate of AUTO_DIALECTS) {
    try {
      parseAndValidate(sql, candidate);
      return;
    } catch (error) {
      if (!(error instanceof SqlPolicyError)) {
        firstError ??= new SqlPolicyError('POLICY_DENIED', 'SQL could not be verified');
        continue;
      }
      firstError ??= error;
    }
  }
  throw firstError ?? new SqlPolicyError('POLICY_DENIED', 'Unable to verify a read-only SELECT statement');
}
