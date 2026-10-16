import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Download, Wallet } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { addDaysYmd, fmtDuration, fmtYmd, localYmd } from '../lib/format';
import { fmtMoney } from '../lib/money';
import type { Payout, PayoutsResponse } from '../lib/types';
import { Avatar, Button, EmptyState, ErrorState, Notice, PageHead, SegmentedControl, Skeleton } from '../components/ui';
import { PayoutSheet, PayoutStatusChip } from '../components/PayoutSheet';
import { useToast } from '../components/Toast';

type Filter = 'pending' | 'paid' | 'all';

function dayLabel(ymd: string, today: string): string {
  if (ymd === today) return 'Today';
  if (ymd === addDaysYmd(today, -1)) return 'Yesterday';
  return fmtYmd(ymd, { weekday: true, year: ymd.slice(0, 4) !== today.slice(0, 4) });
}

export function PayPage() {
  const { me, can } = useAuth();
  const tz = me!.restaurant.timezone;
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('pending');
  const [employee, setEmployee] = useState<string | null>(null);
  const q = useQuery((s) => api.get<PayoutsResponse>('/api/payouts', { status: filter, employee_id: employee }, s), [filter, employee], { tables: ['payouts'] });
  const [openId, setOpenId] = useState<string | null>(params.get('payout'));
  const [extra, setExtra] = useState<Payout | null>(null);
  const today = localYmd(new Date(), tz);

  // Deep link (?payout=…) to a payout that is not in the current list (e.g. already paid).
  useEffect(() => {
    const id = params.get('payout');
    if (!id) return;
    setOpenId(id);
    if (q.data && !q.data.payouts.some((p) => p.id === id)) {
      api.get<PayoutsResponse>('/api/payouts', { status: 'all', id }).then((r) => setExtra(r.payouts[0] ?? null)).catch(() => {});
    }
  }, [params, q.data]);

  const d = q.data;
  const currency = d?.currency ?? 'MYR';
  const selected = (d?.payouts.find((p) => p.id === openId) ?? (extra?.id === openId ? extra : null)) || null;
  const groups = useMemo(() => {
    const m = new Map<string, Payout[]>();
    for (const p of d?.payouts ?? []) m.set(p.work_date, [...(m.get(p.work_date) ?? []), p]);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [d]);

  const close = () => {
    setOpenId(null);
    if (params.get('payout')) {
      params.delete('payout');
      setParams(params, { replace: true });
    }
  };

  const exportCsv = async () => {
    try {
      await downloadFile('/api/reports/payouts.csv', { from: `${today.slice(0, 7)}-01`, to: today }, 'payouts.csv');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <PageHead
        title="Pay"
        lede="Each check-out adds that day’s pay here until it’s paid."
      />

      {q.error && !d ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : (
        <div className="stack">
          <section className="hero-card" aria-label="Outstanding salaries">
            <div className="hero-label">Outstanding</div>
            {d ? <div className="money money-hero" style={{ position: 'relative', zIndex: 1 }}>{fmtMoney(d.summary.pending_cents, currency)}</div> : <Skeleton w={180} h={44} />}
            <div className="hero-sub">{d ? (d.summary.pending_count === 0 ? 'Everyone is paid up' : `${d.summary.pending_count} day${d.summary.pending_count === 1 ? '' : 's'} waiting to be paid`) : ' '}</div>
            <div className="hero-stats">
              <div className="hero-stat"><div className="k">This month</div><div className="v">{d ? fmtMoney(d.summary.paid_month_cents, currency) : '…'}</div></div>
              <div className="hero-stat"><div className="k">Cash</div><div className="v">{d ? fmtMoney(d.summary.paid_month_cash_cents, currency) : '…'}</div></div>
              <div className="hero-stat"><div className="k">QR</div><div className="v">{d ? fmtMoney(d.summary.paid_month_qr_cents, currency) : '…'}</div></div>
            </div>
          </section>

          {d && d.summary.rate_missing_count > 0 && (
            <Notice tone="warning" icon={AlertTriangle}>
              {d.summary.rate_missing_count} day{d.summary.rate_missing_count === 1 ? '' : 's'} can’t be calculated because a salary isn’t set.{' '}
              {can('payroll.rates') ? <Link to="/salaries">Set salaries</Link> : 'Ask the owner to set salaries.'}
            </Notice>
          )}
          {d && d.summary.needs_review_count > 0 && (
            <Notice tone="attention" icon={AlertTriangle}>{d.summary.needs_review_count} payout{d.summary.needs_review_count === 1 ? '' : 's'} changed after attendance was corrected. Tap to check.</Notice>
          )}

          {d && d.pending_by_employee.length > 0 && (
            <div>
              <div className="section-label">Owed to</div>
              <div className="chip-scroll" role="group" aria-label="Filter by employee">
                {d.pending_by_employee.map((e) => (
                  <button key={e.employee_id} type="button" className="owed-chip" aria-pressed={employee === e.employee_id}
                    onClick={() => setEmployee(employee === e.employee_id ? null : e.employee_id)}>
                    <Avatar name={e.full_name} size="sm" />
                    <span style={{ textAlign: 'left' }}>
                      <span className="t" style={{ display: 'block' }}>{e.preferred_name || e.full_name.split(' ')[0]}</span>
                      <span className="s">{fmtMoney(e.cents, currency)} · {e.count} day{e.count === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <SegmentedControl<Filter> label="Show" block value={filter} onChange={setFilter}
            options={[{ value: 'pending', label: 'Pending' }, { value: 'paid', label: 'Paid' }, { value: 'all', label: 'All' }]} />

          {!d ? (
            <div className="group" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="grow-row"><Skeleton w={36} h={36} r={18} /><div className="grow"><Skeleton w="50%" /><div style={{ height: 6 }} /><Skeleton w="30%" h={10} /></div></div>)}
            </div>
          ) : d.payouts.length === 0 ? (
            <div className="card card-pad">
              <EmptyState icon={Wallet} title={filter === 'pending' ? 'Nothing to pay right now' : 'No payouts yet'}>
                {filter === 'pending' ? 'When staff check out, their pay for the day appears here.' : 'Paid salaries will be listed here with their payslip photos.'}
              </EmptyState>
            </div>
          ) : (
            groups.map(([day, list]) => (
              <section key={day} aria-label={dayLabel(day, today)}>
                <div className="section-label">{dayLabel(day, today)}</div>
                <div className="group">
                  {list.map((p) => (
                    <button key={p.id} type="button" className="grow-row" onClick={() => setOpenId(p.id)}>
                      <Avatar name={p.full_name} employeeId={p.employee_id} hasPhoto={p.has_photo} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="t truncate">{p.preferred_name || p.full_name}</div>
                        <div className="s truncate">
                          {fmtDuration(p.worked_minutes)}{p.ot_minutes > 0 ? ` · OT ${fmtDuration(p.ot_minutes)}` : ''}{p.pay_note ? ` · ${p.pay_note}` : ''}
                        </div>
                      </div>
                      <div className="end">
                        <span className="money" style={{ fontSize: 17 }}>{p.rate_missing ? '—' : fmtMoney(p.total_cents, currency)}</span>
                        <PayoutStatusChip p={p} />
                      </div>
                      <ChevronRight className="chev" aria-hidden />
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {d && (
        <div className="center-text" style={{ marginTop: 20 }}>
          <Button variant="ghost" icon={Download} onClick={() => void exportCsv()}>Export this month (CSV)</Button>
        </div>
      )}

      <PayoutSheet
        payout={selected}
        currency={currency}
        standardHours={d?.standard_hours ?? 12}
        open={!!selected}
        onClose={close}
        onChanged={(u) => {
          q.setData((x) => (x ? { ...x, payouts: x.payouts.map((p) => (p.id === u.id ? { ...p, ...u } : p)) } : x));
          if (extra?.id === u.id) setExtra({ ...extra, ...u });
          q.reload();
        }}
      />
    </>
  );
}
