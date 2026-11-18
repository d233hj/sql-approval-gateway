import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { openStore, type Store } from '../src/store.js';
import { randomToken, sha256Hex } from '../src/util.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sag-store-test-'));
}

function cleanupStore(t: TestContext, store: Store, dir: string): void {
  t.after(() => {
    try {
      store.close();
    } catch {
      // A test may already have closed it.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function openTestStore(
  t: TestContext,
  options: { now?: () => number; proposalTtlMs?: number } = {},
): Store {
  const dir = tempDir();
  const store = openStore(join(dir, 'control.db'), options);
  cleanupStore(t, store, dir);
  return store;
}

function addFixtures(store: Store): void {
  store.insertSource({ id: 'source-a', name: 'generated-source', dialect: 'sqlite' });
  store.upsertClient('client-a', 'agent-a', sha256Hex(randomToken(24)));
}

function createProposal(store: Store, requestKey?: string) {
  return store.createProposal({
    clientId: 'client-a',
    sourceId: 'source-a',
    sql: 'SELECT 1 AS one',
    params: { marker: randomToken(8) },
    purpose: 'generated test proposal',
    maxRows: 100,
    timeoutS: 10,
    requestKey: requestKey ?? null,
    digest: sha256Hex(randomToken(16)),
  });
}

test('schema migrates to user_version 3 with WAL and all required tables', (t) => {
  const store = openTestStore(t);
  const version = store.db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, 3);
  const journal = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(journal.journal_mode, 'wal');
  const tables = (
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const required of [
    'audit',
    'clients',
    'proposals',
    'result_meta',
    'result_rows',
    'settings',
    'sources',
  ]) {
    assert.ok(tables.includes(required), `missing table ${required}`);
  }
});

test('concurrent approval succeeds exactly once for a PENDING_APPROVAL proposal', async (t) => {
  const store = openTestStore(t);
  addFixtures(store);
  const proposal = createProposal(store);

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => store.approveProposal(proposal.id, 'admin')),
    ),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  const updated = store.getProposal(proposal.id);
  assert.equal(updated?.status, 'APPROVED');
  assert.equal(
    store.listAudit().filter((entry) => entry.action === 'proposal.approve').length,
    1,
  );
  assert.equal(store.approveProposal(proposal.id, 'admin'), false);
});

test('audit chain verifies and detects a tampered record', (t) => {
  const store = openTestStore(t);
  store.appendAudit({ actor: 'system', action: 'test.one', detail: { n: 1 } });
  store.appendAudit({ actor: 'system', action: 'test.two', detail: { n: 2 } });
  store.appendAudit({ actor: 'admin', action: 'test.three', detail: { n: 3 } });

  const valid = store.verifyAuditChain();
  assert.equal(valid.valid, true);
  assert.equal(valid.checked, 3);

  store.db
    .prepare('UPDATE audit SET detail_json = ? WHERE seq = 2')
    .run(JSON.stringify({ tampered: true }));
  const invalid = store.verifyAuditChain();
  assert.equal(invalid.valid, false);
  assert.equal(invalid.broken_at, 2);
});

test('startup recovery fails interrupted work and expires stale pending proposals', (t) => {
  let now = Date.parse('2026-06-01T00:00:00.000Z');
  const store = openTestStore(t, { now: () => now, proposalTtlMs: 1000 });
  addFixtures(store);

  const approved = createProposal(store);
  const executing = createProposal(store);
  const pending = createProposal(store);
  assert.equal(store.transitionProposal(approved.id, 'PENDING_APPROVAL', 'APPROVED'), true);
  assert.equal(store.transitionProposal(executing.id, 'PENDING_APPROVAL', 'APPROVED'), true);
  assert.equal(store.transitionProposal(executing.id, 'APPROVED', 'EXECUTING'), true);

  now += 5000;
  assert.equal(store.recoverInterrupted(now), 2);
  assert.equal(store.expirePending(now), 1);
  assert.equal(store.getProposal(approved.id)?.status, 'FAILED');
  assert.equal(store.getProposal(approved.id)?.status_message, 'interrupted');
  assert.equal(store.getProposal(executing.id)?.status, 'FAILED');
  assert.equal(store.getProposal(executing.id)?.status_message, 'interrupted');
  assert.equal(store.getProposal(pending.id)?.status, 'EXPIRED');
});

test('request_key idempotency returns the original proposal', (t) => {
  const store = openTestStore(t);
  addFixtures(store);
  const key = randomToken(12);
  const first = createProposal(store, key);
  const second = createProposal(store, key);
  assert.equal(second.id, first.id);
  const count = store.db.prepare('SELECT COUNT(*) AS count FROM proposals').get() as {
    count: number;
  };
  assert.equal(count.count, 1);
});

test('agent token lookup stores only the SHA-256 hash', (t) => {
  const store = openTestStore(t);
  const token = randomToken(32);
  const hash = sha256Hex(token);
  store.upsertClient('client-a', 'agent-a', hash);
  const found = store.findClientByTokenHash(hash);
  assert.equal(found?.id, 'client-a');
  assert.equal(store.findClientByTokenHash(sha256Hex(randomToken(32))), null);
  const listed = store.listClients();
  assert.equal('token_hash' in listed[0]!, false);
});

test('opening an older schema creates control.db.bak-<version> before migrating', (t) => {
  const dir = tempDir();
  const file = join(dir, 'control.db');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE legacy_table (id INTEGER); PRAGMA user_version = 0;');
  legacy.close();

  const store = openStore(file);
  cleanupStore(t, store, dir);
  assert.equal(existsSync(`${file}.bak-0`), true);
  const tables = (
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.deepEqual(tables, ['legacy_table']);
});
