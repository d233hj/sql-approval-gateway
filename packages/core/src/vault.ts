import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

import type { SourceDialect } from '@sql-approval/shared';

import { VaultError } from './errors.js';
import { randomToken } from './util.js';

export const KDF_N = 32768;
export const KDF_R = 8;
export const KDF_P = 1;
export const KDF_KEY_BYTES = 32;
export const KDF_SALT_BYTES = 16;
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const DEK_AAD = 'sag:v1:dek';
export const VAULT_VERSION = 1;

export interface WrappedSecret {
  iv: string;
  tag: string;
  data: string;
}

export interface VaultSource {
  id: string;
  name: string;
  dialect: SourceDialect;
  secret: WrappedSecret;
}

export interface VaultDocument {
  version: 1;
  kdf: {
    algo: 'scrypt';
    N: number;
    r: number;
    p: number;
    salt: string;
  };
  wrapped_dek: WrappedSecret;
  sources: VaultSource[];
}

export interface DecryptedSource {
  id: string;
  name: string;
  dialect: SourceDialect;
  secret: Record<string, unknown>;
}

export interface OpenedVault {
  dek: Buffer;
  doc: VaultDocument;
  sources: DecryptedSource[];
}

export function sourceAad(id: string): string {
  return `sag:v1:source:${id}`;
}

function b64encode(value: Buffer): string {
  return value.toString('base64');
}

function decodeBase64(value: unknown, field: string, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new VaultError('INVALID_VAULT', `vault field ${field} is not valid base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new VaultError('INVALID_VAULT', `vault field ${field} has an invalid length`);
  }
  return decoded;
}

function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(
      password,
      salt,
      KDF_KEY_BYTES,
      { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) rejectPromise(error);
        else resolvePromise(key);
      },
    );
  });
}

export function encryptSecret(key: Buffer, plaintext: Buffer, aad: string): WrappedSecret {
  if (key.length !== KDF_KEY_BYTES) throw new Error('invalid encryption key length');
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipher(key, iv, aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64encode(iv), tag: b64encode(tag), data: b64encode(data) };
}

// Kept as a small helper so encrypt/decrypt cannot drift on the AAD API.
function createCipher(key: Buffer, iv: Buffer, aad: string) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return cipher;
}

export function decryptSecret(key: Buffer, wrapped: WrappedSecret, aad: string): Buffer {
  if (key.length !== KDF_KEY_BYTES) throw new Error('invalid encryption key length');
  try {
    const iv = decodeBase64(wrapped.iv, 'iv', GCM_IV_BYTES);
    const tag = decodeBase64(wrapped.tag, 'tag', GCM_TAG_BYTES);
    const data = decodeBase64(wrapped.data, 'data');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new VaultError('INVALID_PASSWORD', 'Unable to unlock vault');
  }
}

function readWrappedSecret(value: unknown, field: string): WrappedSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VaultError('INVALID_VAULT', `vault field ${field} is invalid`);
  }
  const object = value as Record<string, unknown>;
  const iv = object.iv;
  const tag = object.tag;
  const data = object.data;
  if (typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') {
    throw new VaultError('INVALID_VAULT', `vault field ${field} is invalid`);
  }
  return { iv, tag, data };
}

export function parseVaultDocument(input: unknown): VaultDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new VaultError('INVALID_VAULT', 'Vault file is invalid');
  }
  const doc = input as Record<string, unknown>;
  if (doc.version !== VAULT_VERSION) throw new VaultError('INVALID_VAULT', 'Unsupported vault version');
  const kdf = doc.kdf;
  if (typeof kdf !== 'object' || kdf === null || Array.isArray(kdf)) {
    throw new VaultError('INVALID_VAULT', 'Vault KDF is invalid');
  }
  const kdfObject = kdf as Record<string, unknown>;
  if (
    kdfObject.algo !== 'scrypt' ||
    kdfObject.N !== KDF_N ||
    kdfObject.r !== KDF_R ||
    kdfObject.p !== KDF_P
  ) {
    throw new VaultError('INVALID_VAULT', 'Unsupported vault KDF parameters');
  }
  const salt = kdfObject.salt;
  if (typeof salt !== 'string') throw new VaultError('INVALID_VAULT', 'Vault salt is invalid');
  decodeBase64(salt, 'salt', KDF_SALT_BYTES);

  const rawSources = doc.sources;
  if (!Array.isArray(rawSources)) throw new VaultError('INVALID_VAULT', 'Vault sources are invalid');
  const sources: VaultSource[] = rawSources.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new VaultError('INVALID_VAULT', 'Vault source is invalid');
    }
    const source = raw as Record<string, unknown>;
    if (
      typeof source.id !== 'string' ||
      typeof source.name !== 'string' ||
      typeof source.dialect !== 'string'
    ) {
      throw new VaultError('INVALID_VAULT', 'Vault source is invalid');
    }
    return {
      id: source.id,
      name: source.name,
      dialect: source.dialect as SourceDialect,
      secret: readWrappedSecret(source.secret, `sources[${index}].secret`),
    };
  });

  return {
    version: 1,
    kdf: { algo: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt },
    wrapped_dek: readWrappedSecret(doc.wrapped_dek, 'wrapped_dek'),
    sources,
  };
}

export function readVaultDocument(file: string): VaultDocument {
  if (!existsSync(file)) throw new VaultError('INVALID_VAULT', 'Vault is not configured');
  try {
    return parseVaultDocument(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('INVALID_VAULT', 'Vault file is invalid');
  }
}

export function writeVaultDocument(file: string, doc: VaultDocument): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomToken(6)}`;
  const data = `${JSON.stringify(doc, null, 2)}\n`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, data, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export async function createVault(
  file: string,
  password: string,
): Promise<{ dek: Buffer; doc: VaultDocument }> {
  if (existsSync(file)) throw new VaultError('ALREADY_CONFIGURED', 'Vault is already configured');
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError('INVALID_VAULT', 'Password must not be empty');
  }
  const salt = randomBytes(KDF_SALT_BYTES);
  const kek = await deriveKek(password, salt);
  const dek = randomBytes(KDF_KEY_BYTES);
  const doc: VaultDocument = {
    version: 1,
    kdf: { algo: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: b64encode(salt) },
    wrapped_dek: encryptSecret(kek, dek, DEK_AAD),
    sources: [],
  };
  kek.fill(0);
  try {
    createVaultDocumentExclusive(file, doc);
  } catch (error) {
    dek.fill(0);
    throw error;
  }
  return { dek, doc };
}

/**
 * The first setup writer wins: `open(..., 'wx')` is an atomic, cross-process
 * exclusive create. There is deliberately no check-then-write window here.
 */
function createVaultDocumentExclusive(file: string, doc: VaultDocument): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const data = `${JSON.stringify(doc, null, 2)}\n`;
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      throw new VaultError('ALREADY_CONFIGURED', 'Vault is already configured');
    }
    throw new VaultError('INVALID_VAULT', 'Unable to create vault file');
  }

  let writeError: unknown = null;
  try {
    writeSync(fd, data, null, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    writeError = error;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The write result is more important than a close error.
    }
  }

  if (writeError) {
    try {
      unlinkSync(file);
    } catch {
      // Best effort cleanup of a partially written vault.
    }
    throw new VaultError('INVALID_VAULT', 'Unable to write vault file');
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export async function unwrapVault(
  file: string,
  password: string,
): Promise<{ dek: Buffer; doc: VaultDocument }> {
  const doc = readVaultDocument(file);
  const salt = decodeBase64(doc.kdf.salt, 'salt', KDF_SALT_BYTES);
  const kek = await deriveKek(password, salt);
  try {
    const dek = decryptSecret(kek, doc.wrapped_dek, DEK_AAD);
    if (dek.length !== KDF_KEY_BYTES) throw new Error('invalid DEK length');
    return { dek, doc };
  } catch {
    throw new VaultError('INVALID_PASSWORD', 'Unable to unlock vault');
  } finally {
    kek.fill(0);
  }
}

export async function openVault(file: string, password: string): Promise<OpenedVault> {
  const { dek, doc } = await unwrapVault(file, password);
  try {
    const sources: DecryptedSource[] = doc.sources.map((source) => {
      const plaintext = decryptSecret(dek, source.secret, sourceAad(source.id));
      let secret: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        secret = parsed as Record<string, unknown>;
      } catch {
        throw new VaultError('INVALID_PASSWORD', 'Unable to unlock vault');
      } finally {
        plaintext.fill(0);
      }
      return { id: source.id, name: source.name, dialect: source.dialect, secret };
    });
    return { dek, doc, sources };
  } catch (error) {
    dek.fill(0);
    throw error;
  }
}

export async function rewrapVault(
  file: string,
  currentPassword: string,
  newPassword: string,
  expectedDek?: Buffer,
): Promise<{ dek: Buffer; doc: VaultDocument }> {
  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    throw new VaultError('INVALID_VAULT', 'Password must not be empty');
  }
  const { dek, doc } = await unwrapVault(file, currentPassword);
  if (expectedDek && !timingSafeBufferEqual(expectedDek, dek)) {
    dek.fill(0);
    throw new VaultError('INVALID_PASSWORD', 'Unable to unlock vault');
  }
  const salt = randomBytes(KDF_SALT_BYTES);
  const kek = await deriveKek(newPassword, salt);
  try {
    const next: VaultDocument = {
      ...doc,
      kdf: { algo: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: b64encode(salt) },
      wrapped_dek: encryptSecret(kek, dek, DEK_AAD),
    };
    writeVaultDocument(file, next);
    return { dek, doc: next };
  } catch (error) {
    dek.fill(0);
    throw error;
  } finally {
    kek.fill(0);
  }
}

export function resetVault(file: string): string | null {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  renameSync(file, backup);
  return backup;
}

export class VaultService {
  readonly file: string;
  private doc: VaultDocument | null = null;
  private dek: Buffer | null = null;
  private decryptedSources = new Map<string, DecryptedSource>();

  constructor(file: string) {
    this.file = file;
  }

  get configured(): boolean {
    return existsSync(this.file);
  }

  get unlocked(): boolean {
    return this.dek !== null;
  }

  get plaintextSources(): readonly DecryptedSource[] {
    return [...this.decryptedSources.values()];
  }

  /**
   * Returns a copy of the decrypted connection settings for one source, or
   * null when the vault is locked or the source is unknown. Callers must not
   * log, echo or persist the returned object.
   */
  getSourceSecret(id: string): Record<string, unknown> | null {
    const source = this.decryptedSources.get(id);
    if (!source) return null;
    return { ...source.secret };
  }

  async setup(password: string): Promise<void> {
    const { dek } = await createVault(this.file, password);
    dek.fill(0);
    this.zeroAndClear();
  }

  async unlock(password: string): Promise<void> {
    const opened = await openVault(this.file, password);
    this.zeroAndClear();
    this.dek = opened.dek;
    this.doc = opened.doc;
    this.decryptedSources = new Map(opened.sources.map((source) => [source.id, source]));
  }

  lock(): void {
    this.zeroAndClear();
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const currentDek = this.requireUnlocked();
    const { dek, doc } = await rewrapVault(
      this.file,
      currentPassword,
      newPassword,
      currentDek,
    );
    try {
      this.doc = doc;
    } finally {
      dek.fill(0);
    }
  }

  async addSource(
    metadata: { id: string; name: string; dialect: SourceDialect },
    connection: Record<string, unknown>,
  ): Promise<void> {
    const dek = this.requireUnlocked();
    const doc = this.currentDoc();
    if (doc.sources.some((source) => source.id === metadata.id)) {
      throw new VaultError('INVALID_VAULT', 'Source already exists');
    }
    const secret = encryptSecret(
      dek,
      Buffer.from(JSON.stringify(connection), 'utf8'),
      sourceAad(metadata.id),
    );
    const next: VaultDocument = {
      ...doc,
      sources: [...doc.sources, { ...metadata, secret }],
    };
    writeVaultDocument(this.file, next);
    this.doc = next;
    this.decryptedSources.set(metadata.id, { ...metadata, secret: { ...connection } });
  }

  /**
   * Partial source update. Metadata fields that are not provided are kept.
   * The connection is shallow-merged over the stored one, so a caller that
   * only rotates the password does not have to resend host/file/database.
   * An omitted or empty `password` keeps the previous password.
   *
   * When `connection` is omitted the wrapped secret is left byte-for-byte
   * untouched (renaming never rewrites the connection ciphertext). When it is
   * provided the whole connection is re-encrypted under the same AAD.
   */
  async updateSource(
    id: string,
    patch: {
      name?: string;
      dialect?: SourceDialect;
      connection?: Record<string, unknown>;
    },
  ): Promise<SourceMetadata> {
    const dek = this.requireUnlocked();
    const doc = this.currentDoc();
    const existing = doc.sources.find((source) => source.id === id);
    const decrypted = this.decryptedSources.get(id);
    if (!existing || !decrypted) {
      throw new VaultError('INVALID_VAULT', 'Source is missing from the vault');
    }

    const metadata: SourceMetadata = {
      id,
      name: patch.name ?? existing.name,
      dialect: patch.dialect ?? existing.dialect,
    };

    let secret = existing.secret;
    let plaintext = decrypted.secret;
    if (patch.connection !== undefined) {
      const merged: Record<string, unknown> = { ...decrypted.secret, ...patch.connection };
      const providedPassword = patch.connection.password;
      if (typeof providedPassword !== 'string' || providedPassword.length === 0) {
        if (typeof decrypted.secret.password === 'string' && decrypted.secret.password.length > 0) {
          merged.password = decrypted.secret.password;
        } else {
          delete merged.password;
        }
      }
      secret = encryptSecret(dek, Buffer.from(JSON.stringify(merged), 'utf8'), sourceAad(id));
      plaintext = merged;
    }

    const next: VaultDocument = {
      ...doc,
      sources: doc.sources.map((source) => (source.id === id ? { ...metadata, secret } : source)),
    };
    writeVaultDocument(this.file, next);
    this.doc = next;
    this.decryptedSources.set(id, {
      id: metadata.id,
      name: metadata.name,
      dialect: metadata.dialect,
      secret: { ...plaintext },
    });
    return metadata;
  }

  async removeSource(id: string): Promise<void> {
    this.requireUnlocked();
    const doc = this.currentDoc();
    const next: VaultDocument = { ...doc, sources: doc.sources.filter((source) => source.id !== id) };
    writeVaultDocument(this.file, next);
    this.doc = next;
    this.decryptedSources.delete(id);
  }

  listSourceMetadata(): SourceMetadata[] {
    if (this.doc) {
      return this.doc.sources.map(({ id, name, dialect }) => ({ id, name, dialect }));
    }
    if (!this.configured) return [];
    return readVaultDocument(this.file).sources.map(({ id, name, dialect }) => ({
      id,
      name,
      dialect,
    }));
  }

  reset(): string | null {
    this.lock();
    return resetVault(this.file);
  }

  private requireUnlocked(): Buffer {
    if (!this.dek) throw new VaultError('INVALID_PASSWORD', 'Vault is locked');
    return this.dek;
  }

  private currentDoc(): VaultDocument {
    if (!this.doc) throw new VaultError('INVALID_PASSWORD', 'Vault is locked');
    return this.doc;
  }

  private zeroAndClear(): void {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
    this.doc = null;
    this.decryptedSources.clear();
  }
}

export interface SourceMetadata {
  id: string;
  name: string;
  dialect: SourceDialect;
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}
