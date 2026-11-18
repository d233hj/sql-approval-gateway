/**
 * In-process server-sent-events fan-out for the approval console.
 *
 * The proposal lifecycle (create/approve/reject/cancel/expire) publishes one
 * small event per change; every open `GET /v1/events` stream receives it and
 * refreshes its own list. Payloads carry only an id, a source label and a
 * timestamp: never SQL text, parameters or connection data (DESIGN §4.3/§6.1).
 *
 * Failure isolation is deliberate: a subscriber whose socket died is dropped
 * on the next write, and a broadcast can never throw into the request path
 * that triggered it.
 */

/** Minimal `http.ServerResponse` surface the bus needs (easy to fake in tests). */
export interface EventStreamResponse {
  write(chunk: string): boolean;
  end(): void;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
}

export type ProposalEventType = 'proposal.created' | 'proposal.updated';

export interface ProposalEvent {
  type: ProposalEventType;
  /** Proposal id only — never the SQL. */
  id: string;
  /** Source display name when known, otherwise its id. */
  source: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Keeps proxies and idle timeouts from dropping a quiet stream. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

interface Subscriber {
  response: EventStreamResponse;
  heartbeat: NodeJS.Timeout;
}

/** One SSE frame: `event: <type>` + one-line JSON `data:` + blank line. */
export function formatProposalEvent(event: ProposalEvent): string {
  const data = JSON.stringify({ id: event.id, source: event.source, at: event.at });
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

export class ProposalEventBus {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly heartbeatMs: number = HEARTBEAT_INTERVAL_MS) {}

  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Registers one open response. The heartbeat belongs to the subscriber, so
   * `unsubscribe` (called from the request/response close hooks) clears it.
   */
  subscribe(response: EventStreamResponse): void {
    const subscriber: Subscriber = {
      response,
      heartbeat: setInterval(() => {
        if (this.writeTo(subscriber, ': ping\n\n')) return;
        this.remove(subscriber);
      }, this.heartbeatMs),
    };
    // A heartbeat must never keep a shutting-down process alive.
    subscriber.heartbeat.unref?.();
    this.subscribers.add(subscriber);
  }

  unsubscribe(response: EventStreamResponse): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.response === response) this.remove(subscriber);
    }
  }

  /** Fans one event out; dead subscribers are removed instead of throwing. */
  broadcast(event: ProposalEvent): void {
    const payload = formatProposalEvent(event);
    for (const subscriber of this.subscribers) {
      if (!this.writeTo(subscriber, payload)) this.remove(subscriber);
    }
  }

  /** Ends every stream (lock, shutdown); idempotent and never throws. */
  closeAll(): void {
    for (const subscriber of this.subscribers) {
      clearInterval(subscriber.heartbeat);
      try {
        subscriber.response.end();
      } catch {
        // The socket may already be gone; nothing left to clean up.
      }
    }
    this.subscribers.clear();
  }

  private remove(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    clearInterval(subscriber.heartbeat);
  }

  private writeTo(subscriber: Subscriber, chunk: string): boolean {
    const { response } = subscriber;
    if (response.writableEnded || response.destroyed) return false;
    try {
      response.write(chunk);
      return true;
    } catch {
      return false;
    }
  }
}
