import pg from 'pg';
import type { FastifyReply } from 'fastify';

export interface ChangeEvent {
  restaurant_id: string;
  table: string;
  op: string;
  id: string;
}

type Listener = (e: ChangeEvent) => void;

/**
 * Bridges Postgres LISTEN/NOTIFY to in-process subscribers. Because NOTIFY fires on
 * COMMIT, subscribers only ever hear about committed changes, and every API instance
 * receives every change — so dashboards on any device stay consistent.
 */
export class RealtimeHub {
  private client: pg.Client | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly ssl: boolean,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url, ssl: this.ssl ? { rejectUnauthorized: true } : undefined });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const e = JSON.parse(msg.payload) as ChangeEvent;
        for (const l of this.globalListeners) l(e);
        for (const l of this.listeners.get(e.restaurant_id) ?? []) l(e);
      } catch {
        /* ignore malformed */
      }
    });
    const retry = () => {
      if (this.stopped || this.reconnectTimer) return;
      this.client = null;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(retry);
      }, 2000);
    };
    client.on('error', (err) => {
      console.error('[realtime] listener error', err.message);
      client.end().catch(() => {});
      retry();
    });
    client.on('end', retry);
    await client.connect();
    await client.query('LISTEN attendance_changes');
    this.client = client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  subscribe(restaurantId: string, l: Listener): () => void {
    const set = this.listeners.get(restaurantId) ?? new Set();
    set.add(l);
    this.listeners.set(restaurantId, set);
    return () => {
      set.delete(l);
      if (set.size === 0) this.listeners.delete(restaurantId);
    };
  }

  onAny(l: Listener): () => void {
    this.globalListeners.add(l);
    return () => this.globalListeners.delete(l);
  }

  connectionCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

/** Streams change events for one restaurant as Server-Sent Events. */
export function streamToReply(hub: RealtimeHub, restaurantId: string, reply: FastifyReply): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\nevent: ready\ndata: {}\n\n`);
  const unsubscribe = hub.subscribe(restaurantId, (e) => {
    res.write(`event: change\ndata: ${JSON.stringify({ table: e.table, op: e.op, id: e.id })}\n\n`);
  });
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25_000);
  const close = () => {
    clearInterval(ping);
    unsubscribe();
  };
  res.on('close', close);
  res.on('error', close);
}
