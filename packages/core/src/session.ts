import { randomToken, sha256Hex } from './util.js';

export type SessionDuration = number | (() => number);

export interface SessionOptions {
  /**
   * Idle / absolute bounds are resolved on every check so a settings update
   * takes effect for existing sessions immediately (no session reload needed).
   */
  idleMs: SessionDuration;
  absoluteMs: SessionDuration;
  clock?: () => number;
  onEmpty?: () => void;
}

export interface SessionRecord {
  token: string;
  csrfToken: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  ref: string;
  expiresAt: number;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
  session: SessionRecord;
}

interface SessionEntry extends SessionRecord {
  key: string;
}

/**
 * In-memory admin sessions. Tokens are never persisted. Each session has an
 * idle deadline and an absolute deadline; rejecting the last live session
 * invokes onEmpty so the owner can wipe the DEK.
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly idleMs: SessionDuration;
  private readonly absoluteMs: SessionDuration;
  private readonly clock: () => number;
  private readonly onEmpty: (() => void) | undefined;

  constructor(options: SessionOptions) {
    this.idleMs = options.idleMs;
    this.absoluteMs = options.absoluteMs;
    this.clock = options.clock ?? Date.now;
    this.onEmpty = options.onEmpty;
  }

  private idleDuration(): number {
    return typeof this.idleMs === 'function' ? this.idleMs() : this.idleMs;
  }

  private absoluteDuration(): number {
    return typeof this.absoluteMs === 'function' ? this.absoluteMs() : this.absoluteMs;
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  create(ip: string, ref: string): CreatedSession {
    this.pruneExpired();
    const now = this.clock();
    const idleMs = this.idleDuration();
    const absoluteMs = this.absoluteDuration();
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const key = sha256Hex(token);
    const entry: SessionEntry = {
      key,
      token,
      csrfToken,
      createdAt: now,
      lastSeen: now,
      ip,
      ref,
      expiresAt: Math.min(now + idleMs, now + absoluteMs),
    };
    this.entries.set(key, entry);
    return {
      token,
      csrfToken,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      session: entry,
    };
  }

  get(token: string | null | undefined): SessionRecord | null {
    if (!token) return null;
    const key = sha256Hex(token);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = this.clock();
    const idleMs = this.idleDuration();
    const absoluteMs = this.absoluteDuration();
    if (now >= entry.createdAt + absoluteMs || now >= entry.lastSeen + idleMs) {
      this.entries.delete(key);
      this.fireEmptyIfNeeded();
      return null;
    }
    entry.lastSeen = now;
    entry.expiresAt = Math.min(entry.lastSeen + idleMs, entry.createdAt + absoluteMs);
    return entry;
  }

  invalidateOthers(keepToken: string): void {
    const keep = sha256Hex(keepToken);
    for (const key of [...this.entries.keys()]) {
      if (key !== keep) this.entries.delete(key);
    }
    this.fireEmptyIfNeeded();
  }

  clear(): void {
    this.entries.clear();
  }

  /** Remove expired entries and report whether any were removed. */
  pruneExpired(): void {
    const now = this.clock();
    const idleMs = this.idleDuration();
    const absoluteMs = this.absoluteDuration();
    let removed = false;
    for (const [key, entry] of this.entries) {
      if (now >= entry.createdAt + absoluteMs || now >= entry.lastSeen + idleMs) {
        this.entries.delete(key);
        removed = true;
      }
    }
    if (removed) this.fireEmptyIfNeeded();
  }

  private fireEmptyIfNeeded(): void {
    if (this.entries.size === 0) this.onEmpty?.();
  }
}
