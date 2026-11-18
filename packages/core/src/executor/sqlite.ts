import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { ResultColumn } from '../result.js';
import { ExecutorError } from './errors.js';
import type { ConnectorOptions, ConnectorResult } from './types.js';
import { normalizeCell } from './values.js';

/** Rows read between event-loop yields so a cancel/timeout can be observed. */
const YIELD_EVERY_ROWS = 200;

/**
 * Subset of node:sqlite's `StatementColumnMetadata` that the mapping depends
 * on. The fields are read defensively because `name` (result alias) is empty
 * for some runtimes/expressions and `column` (origin column) may be the only
 * populated field.
 */
export interface SqliteColumnMetadata {
  name?: unknown;
  column?: unknown;
  type?: unknown;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Skips a quoted SQL token; returns the index just after the closing quote. */
function skipQuoted(sql: string, start: number): number {
  const quote = sql[start]!;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipBracket(sql: string, start: number): number {
  const end = sql.indexOf(']', start + 1);
  return end === -1 ? sql.length : end + 1;
}

/** Returns the index after a `--`/`/* *\/` comment, or null when not at one. */
function skipComment(sql: string, start: number): number | null {
  if (sql[start] === '-' && sql[start + 1] === '-') {
    const end = sql.indexOf('\n', start + 2);
    return end === -1 ? sql.length : end + 1;
  }
  if (sql[start] === '/' && sql[start + 1] === '*') {
    const end = sql.indexOf('*/', start + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return null;
}

function matchesKeyword(sql: string, index: number, keyword: string): boolean {
  if (/[\w$]/.test(sql[index - 1] ?? '')) return false;
  if (sql.slice(index, index + keyword.length).toLowerCase() !== keyword) return false;
  return !/[\w$]/.test(sql[index + keyword.length] ?? '');
}

/**
 * Extracts the top-level SELECT list (the text between SELECT and FROM). CTE
 * bodies live inside parentheses, so the first depth-0 SELECT is the main one.
 */
function selectListText(sql: string): string | null {
  let depth = 0;
  let start = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(sql, index) - 1;
      continue;
    }
    if (char === '[') {
      index = skipBracket(sql, index) - 1;
      continue;
    }
    const commentEnd = skipComment(sql, index);
    if (commentEnd !== null) {
      index = commentEnd - 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (start === -1) {
      if (matchesKeyword(sql, index, 'select')) {
        start = index + 'select'.length;
        index = start - 1;
      }
      continue;
    }
    if (matchesKeyword(sql, index, 'from')) {
      return sql.slice(start, index);
    }
  }
  return start === -1 ? null : sql.slice(start);
}

/** Splits on a delimiter that is not inside quotes, comments or parentheses. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(text, index) - 1;
      continue;
    }
    if (char === '[') {
      index = skipBracket(text, index) - 1;
      continue;
    }
    const commentEnd = skipComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd - 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0 && char === delimiter) {
      const part = text.slice(start, index).trim();
      if (part.length > 0) parts.push(part);
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

const AS_ALIAS =
  /\s+as\s+("[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*)\s*$/i;
const QUOTED_ALIAS = /\s+("[^"]*"|`[^`]*`|\[[^\]]*\])\s*$/;

function unquoteAlias(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if (first === '"' && last === '"') return token.slice(1, -1).replace(/""/g, '"');
    if (first === "'" && last === "'") return token.slice(1, -1).replace(/''/g, "'");
    if (first === '`' && last === '`') return token.slice(1, -1).replace(/``/g, '`');
    if (first === '[' && last === ']') return token.slice(1, -1);
  }
  return token;
}

/** Splits `expr AS alias` (or `expr "alias"`) into expression and alias. */
function splitExpression(expression: string): { text: string; alias: string | null } {
  const clean = expression.replace(/;\s*$/, '').trim();
  const asMatch = AS_ALIAS.exec(clean);
  if (asMatch && asMatch.index > 0) {
    return { text: clean.slice(0, asMatch.index).trim(), alias: unquoteAlias(asMatch[1]!) };
  }
  const quotedMatch = QUOTED_ALIAS.exec(clean);
  if (quotedMatch && quotedMatch.index > 0) {
    return { text: clean.slice(0, quotedMatch.index).trim(), alias: unquoteAlias(quotedMatch[1]!) };
  }
  return { text: clean, alias: null };
}

function expressionLabel(expression: string): string {
  const { text, alias } = splitExpression(expression);
  return alias !== null && alias.length > 0 ? alias : text;
}

function isStarLabel(label: string): boolean {
  return /^(?:[A-Za-z_][\w$]*\.)?\*$/.test(label.trim());
}

/** Best-effort result-column labels derived from the SELECT list. */
function sqliteSelectLabels(sql: string): string[] {
  const list = selectListText(sql);
  if (list === null) return [];
  const items = splitTopLevel(list, ',');
  if (items.length > 0) {
    items[0] = items[0]!.replace(/^(?:distinct|all)\b\s*/i, '').trim();
  }
  return items.map((item) => expressionLabel(item)).filter((label) => label.length > 0);
}

/**
 * Maps node:sqlite column metadata to result columns.
 *
 * `name` is the result name (`sqlite3_column_name`), which is the alias when
 * one is present. Some runtimes/statements leave it empty; then the SELECT
 * list is used (alias or expression text), then `column` (the unaliased origin
 * name), and finally a positional placeholder. `SELECT *` is never expanded
 * from SQL, so origin names are preferred there.
 */
export function resolveSqliteColumns(
  rawColumns: readonly SqliteColumnMetadata[],
  sql: string,
): ResultColumn[] {
  const labels = sqliteSelectLabels(sql);
  const labelsAligned = labels.length === rawColumns.length;
  return rawColumns.map((column, index) => {
    const declaredName = typeof column.name === 'string' ? column.name : '';
    const originName = typeof column.column === 'string' ? column.column : '';
    let name = declaredName.trim().length > 0 ? declaredName : '';
    if (name.length === 0 && labelsAligned) {
      const label = labels[index]!;
      if (label.length > 0 && !isStarLabel(label)) name = label;
    }
    if (name.length === 0 && originName.trim().length > 0) name = originName;
    if (name.length === 0) name = `column_${index + 1}`;
    const type = hasText(column.type) ? column.type : undefined;
    return type === undefined ? { name } : { name, type };
  });
}

export function resolveSqliteFile(connection: Record<string, unknown>): string {
  for (const key of ['file', 'database', 'path', 'filename'] as const) {
    const value = connection[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  throw new ExecutorError('QUERY_FAILED', 'SQLite source has no database file configured');
}

function bindParameters(
  statement: StatementSync,
  params: unknown,
): unknown[] {
  if (params === null || params === undefined) return [];
  if (Array.isArray(params)) return params;
  if (typeof params === 'object') {
    statement.setAllowBareNamedParameters(true);
    return [params];
  }
  throw new ExecutorError('QUERY_FAILED', 'Unsupported parameter shape');
}

/**
 * Reads rows one at a time, stopping after max_rows + 1 rows to detect
 * truncation, then closes the statement (via `db.close()`). The database is
 * opened read-only; writes are rejected by SQLite itself.
 */
export async function executeSqliteQuery(
  connection: Record<string, unknown>,
  sql: string,
  params: unknown,
  options: ConnectorOptions,
): Promise<ConnectorResult> {
  const started = Date.now();
  const file = resolveSqliteFile(connection);
  const maxRows = Math.max(1, Math.trunc(options.maxRows));
  let db: DatabaseSync | null = null;

  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');

    let statement: StatementSync;
    try {
      statement = db.prepare(sql);
    } catch (error) {
      throw new ExecutorError('QUERY_FAILED', 'Unable to prepare the query');
    }
    statement.setReadBigInts(true);
    // Row values must not be keyed by the display name: a fallback label (or a
    // duplicate/empty alias) would not match the driver's row-object keys.
    const returnsArrays = typeof statement.setReturnArrays === 'function';
    if (returnsArrays) statement.setReturnArrays(true);
    let columns: ResultColumn[];
    try {
      columns = resolveSqliteColumns(
        statement.columns() as unknown as SqliteColumnMetadata[],
        sql,
      );
    } catch {
      columns = [];
    }

    const args = bindParameters(statement, params);
    const rows: unknown[][] = [];
    let truncated = false;
    let read = 0;

    let iterator: IterableIterator<unknown>;
    try {
      iterator = statement.iterate(...(args as never[])) as unknown as IterableIterator<unknown>;
    } catch (error) {
      throw new ExecutorError('QUERY_FAILED', 'Unable to bind query parameters');
    }

    for (const row of iterator) {
      read += 1;
      if (rows.length >= maxRows) {
        // The (max_rows + 1)-th row proves there is more data.
        truncated = true;
        break;
      }
      const cells: unknown[] = Array.isArray(row)
        ? row
        : row !== null && typeof row === 'object'
          ? Object.values(row as Record<string, unknown>)
          : [row];
      rows.push(columns.map((_, index) => normalizeCell(cells[index])));
      if (options.cancel.cancelled) {
        throw new ExecutorError('CANCELLED', 'Query was cancelled');
      }
      if (Date.now() - started > options.timeoutMs) {
        throw new ExecutorError('QUERY_TIMEOUT', 'Query timed out');
      }
      if (read % YIELD_EVERY_ROWS === 0) {
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
    }

    return {
      columns,
      rows,
      truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    // Closing the database finalises every open statement, including one that
    // is abandoned because of a timeout or a lock.
    try {
      db?.close();
    } catch {
      // The connection may already be closed by the driver.
    }
  }
}
