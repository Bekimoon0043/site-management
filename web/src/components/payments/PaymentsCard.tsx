// Dashboard card (payment roles): certificates / payrolls waiting at each step and what was paid this month.
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAsync } from '../../lib/hooks';
import type { PaymentStatus } from '../../lib/contract-payments';
import { Card, Loading } from '../Page';
import { etb, loadRegister } from './data';

const STEPS: { s: PaymentStatus; label: string }[] = [
  { s: 'submitted', label: 'To check (coordinator)' }, { s: 'checked', label: 'To approve (manager)' }, { s: 'approved', label: 'To pay (finance)' }, { s: 'returned', label: 'Returned for correction' },
];

export function PaymentsCard({ projectId }: { projectId: string }) {
  const q = useAsync(() => loadRegister(projectId), [projectId], { key: 'payment-register' });
  const rows = q.data ?? [];
  const month = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
  const paid = rows.filter((r) => r.status === 'paid' && (r.payment_date ?? '').startsWith(month));
  return (
    <Card title="Payments" sub={`Paid this month ${etb(paid.reduce((s, r) => s + Number(r.net), 0))} ETB`} actions={<Link to="/payments/finance">Finance <ArrowRight size={12} aria-hidden /></Link>}>
      {!q.data ? <Loading lines={4} /> : STEPS.map((st) => {
        const xs = rows.filter((r) => r.status === st.s);
        return (
          <div className="hbar-row" key={st.s}>
            <span className="muted">{st.label}</span>
            <span className="tnum">{etb(xs.reduce((s, r) => s + Number(r.net), 0))}</span>
            <span className="right tnum strong">{xs.length}</span>
          </div>
        );
      })}
    </Card>
  );
}
