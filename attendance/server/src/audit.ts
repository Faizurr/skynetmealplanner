import type { Tx } from './db.js';

export interface Actor {
  type: 'user' | 'device' | 'system';
  id: string | null;
  ip?: string | null;
}

export async function audit(
  tx: Tx,
  restaurantId: string | null,
  actor: Actor,
  action: string,
  entity: { type?: string; id?: string | null } = {},
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (restaurant_id, actor_type, actor_id, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [restaurantId, actor.type, actor.id, action, entity.type ?? null, entity.id ?? null, details, actor.ip ?? null],
  );
}
