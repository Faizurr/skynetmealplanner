import { Link } from 'react-router-dom';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { NAV } from '../components/Layout';
import { Button, Card, PageHead } from '../components/ui';
import { RestaurantSwitcher } from '../components/RestaurantSwitcher';
import { ROLE_LABELS } from '../lib/status';

/** Mobile "More" tab: everything not in the bottom bar. */
export function MorePage() {
  const { me, can, signOut } = useAuth();
  const items = NAV.filter((n) => !['/', '/live', '/staff', '/alerts'].includes(n.to) && (!n.perm || can(n.perm)));
  return (
    <>
      <PageHead title="More" lede={me ? `${me.user.full_name} · ${ROLE_LABELS[me.role]}` : undefined} />
      <div className="stack">
        <RestaurantSwitcher />
        <Card>
          <nav className="list" aria-label="More sections">
            {items.map((n) => (
              <Link key={n.to} to={n.to} className="list-item">
                <span className="attention-icon tone-neutral"><n.icon aria-hidden /></span>
                <span className="grow strong small">{n.label}</span>
                <ChevronRight className="chev" aria-hidden />
              </Link>
            ))}
          </nav>
        </Card>
        <Button icon={LogOut} onClick={() => void signOut()}>Sign out</Button>
      </div>
    </>
  );
}
