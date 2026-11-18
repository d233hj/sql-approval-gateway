export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface AttemptState {
  windowStart: number;
  windowCount: number;
  consecutiveFailures: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  windowMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Login/unlock limiter: at most 10 attempts per minute per IP and exponential
 * backoff after 10 consecutive failures (30s doubling, capped at 5 minutes).
 */
export class AttemptRateLimiter {
  private readonly states = new Map<string, AttemptState>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.initialBackoffMs = options.initialBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  }

  begin(ip: string, now = Date.now()): RateLimitDecision {
    const state = this.stateFor(ip, now);
    if (state.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)),
      };
    }
    if (now - state.windowStart >= this.windowMs) {
      state.windowStart = now;
      state.windowCount = 0;
    }
    if (state.windowCount >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((state.windowStart + this.windowMs - now) / 1000),
        ),
      };
    }
    state.windowCount += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(ip: string, now = Date.now()): void {
    const state = this.stateFor(ip, now);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.maxAttempts) {
      const exponent = state.consecutiveFailures - this.maxAttempts;
      const backoff = Math.min(
        this.initialBackoffMs * 2 ** Math.min(exponent, 10),
        this.maxBackoffMs,
      );
      state.blockedUntil = now + backoff;
    }
  }

  recordSuccess(ip: string): void {
    const state = this.states.get(ip);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.blockedUntil = 0;
  }

  private stateFor(ip: string, now: number): AttemptState {
    let state = this.states.get(ip);
    if (!state) {
      state = {
        windowStart: now,
        windowCount: 0,
        consecutiveFailures: 0,
        blockedUntil: 0,
      };
      this.states.set(ip, state);
    }
    return state;
  }
}
