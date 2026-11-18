import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { VaultError } from '../src/errors.js';
import { randomToken } from '../src/util.js';
import {
  VaultService,
  openVault,
  readVaultDocument,
  resetVault,
  writeVaultDocument,
  type VaultDocument,
} from '../src/vault.js';
import { uniquePassword } from './helpers.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sag-vault-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

function rewrite(file: string, mutate: (doc: VaultDocument) => void): void {
  const doc = readVaultDocument(file);
  mutate(doc);
  writeVaultDocument(file, doc);
}

test('vault round-trips the DEK and source secrets through lock/unlock', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const password = uniquePassword();
  const marker = randomToken(24);
  const service = new VaultService(file);

  await service.setup(password);
  assert.equal(service.unlocked, false, 'setup must leave the vault locked');
  await service.unlock(password);
  await service.addSource(
    { id: 'source-a', name: 'generated-source', dialect: 'sqlite' },
    { credential_marker: marker },
  );
  assert.deepEqual(service.plaintextSources[0]?.secret, { credential_marker: marker });

  service.lock();
  await service.unlock(password);
  assert.deepEqual(service.plaintextSources[0]?.secret, { credential_marker: marker });
  service.lock();

  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(marker), false, 'plaintext secret must not be persisted');
  assert.equal(raw.includes(password), false, 'password must not be persisted');
  const opened = await openVault(file, password);
  assert.equal(opened.dek.length, 32);
  assert.equal(opened.doc.sources.length, 1);
  opened.dek.fill(0);
});

test('wrong password and tampered wrapped DEK return the same generic failure', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const password = uniquePassword();
  const service = new VaultService(file);
  await service.setup(password);

  let wrongError: unknown;
  try {
    await service.unlock(uniquePassword());
  } catch (error) {
    wrongError = error;
  }
  assert.ok(wrongError instanceof VaultError);
  assert.equal(wrongError.code, 'INVALID_PASSWORD');

  rewrite(file, (doc) => {
    doc.wrapped_dek.data = flipBase64(doc.wrapped_dek.data);
  });
  let tamperedError: unknown;
  try {
    await openVault(file, password);
  } catch (error) {
    tamperedError = error;
  }
  assert.ok(tamperedError instanceof VaultError);
  assert.equal(tamperedError.code, wrongError.code);
  assert.equal(tamperedError.message, wrongError.message);
});

test('source ciphertext moved to another source id fails AAD authentication', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const password = uniquePassword();
  const service = new VaultService(file);
  await service.setup(password);
  await service.unlock(password);
  await service.addSource(
    { id: 'source-a', name: 'first', dialect: 'sqlite' },
    { credential_marker: randomToken(24) },
  );
  await service.addSource(
    { id: 'source-b', name: 'second', dialect: 'sqlite' },
    { credential_marker: randomToken(24) },
  );
  service.lock();

  rewrite(file, (doc) => {
    assert.equal(doc.sources.length, 2);
    doc.sources[1]!.secret = doc.sources[0]!.secret;
  });

  await assert.rejects(
    () => openVault(file, password),
    (error: unknown) => error instanceof VaultError && error.code === 'INVALID_PASSWORD',
  );
});

test('password rewrap keeps source ciphertext decryptable', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const oldPassword = uniquePassword();
  const newPassword = uniquePassword();
  const marker = randomToken(24);
  const service = new VaultService(file);

  await service.setup(oldPassword);
  await service.unlock(oldPassword);
  await service.addSource(
    { id: 'source-a', name: 'generated-source', dialect: 'sqlite' },
    { credential_marker: marker },
  );
  await service.changePassword(oldPassword, newPassword);
  service.lock();

  await assert.rejects(
    () => service.unlock(oldPassword),
    (error: unknown) => error instanceof VaultError && error.code === 'INVALID_PASSWORD',
  );
  await service.unlock(newPassword);
  assert.deepEqual(service.plaintextSources[0]?.secret, { credential_marker: marker });
  service.lock();

  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(oldPassword), false);
  assert.equal(raw.includes(newPassword), false);
});

test('reset backs up vault.json and returns to an unconfigured state', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const service = new VaultService(file);
  await service.setup(uniquePassword());
  assert.equal(service.configured, true);

  const backup = resetVault(file);
  assert.ok(backup);
  assert.equal(service.configured, false);
  assert.equal(readFileSync(backup!, 'utf8').includes('wrapped_dek'), true);
  assert.equal(service.reset(), null);
});

test('scrypt parameters and wrapped field sizes match the v1 vault format', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'vault.json');
  const service = new VaultService(file);
  await service.setup(uniquePassword());
  const doc = readVaultDocument(file);

  assert.deepEqual(
    { algo: doc.kdf.algo, N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p },
    { algo: 'scrypt', N: 32768, r: 8, p: 1 },
  );
  assert.equal(Buffer.from(doc.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(doc.wrapped_dek.iv, 'base64').length, 12);
  assert.equal(Buffer.from(doc.wrapped_dek.tag, 'base64').length, 16);
  assert.equal(Buffer.from(doc.wrapped_dek.data, 'base64').length, 32);
});
