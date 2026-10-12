import { useId, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { ROLE_LABELS } from '../lib/status';

/** Shown only when the user belongs to more than one restaurant. */
export function RestaurantSwitcher({ compact }: { compact?: boolean }) {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const id = useId();
  if (!me || me.memberships.length < 2) return null;
  return (
    <div className="field">
      <label className={compact ? 'field-help' : 'field-label'} htmlFor={id}>Restaurant</label>
      <select
        id={id}
        className="select"
        value={me.restaurant.id}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          try {
            await api.post('/api/auth/switch', { restaurant_id: e.target.value });
            window.location.hash = '#/';
            window.location.reload();
          } catch (err) {
            toast.error(err);
            setBusy(false);
          }
        }}
      >
        {me.memberships.map((m) => (
          <option key={m.restaurant_id} value={m.restaurant_id}>
            {m.name} · {ROLE_LABELS[m.role] ?? m.role}
          </option>
        ))}
      </select>
    </div>
  );
}
