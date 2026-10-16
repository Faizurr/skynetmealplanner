import { useEffect, useId, useState } from 'react';
import { ChevronRight, Lock, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { fmtYmd } from '../lib/format';
import { fmtMoney, parseAmount } from '../lib/money';
import type { RateRow, RatesResponse } from '../lib/types';
import { Avatar, Button, EmptyState, ErrorState, InlineError, Input, Notice, PageHead, Skeleton } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

interface History { rates: { daily_rate_cents: number; effective_from: string; created_at: string; set_by: string | null }[] }

function RateSheet({ row, data, onClose, onSaved }: { row: RateRow | null; data: RatesResponse; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('payroll.rates');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(data.today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amountId = useId();
  const fromId = useId();
  const hist = useQuery((s) => (row ? api.get<History>(`/api/employees/${row.employee_id}/rates`, undefined, s) : Promise.resolve({ rates: [] })), [row?.employee_id]);

  useEffect(() => {
    if (row) {
      setAmount(row.daily_rate_cents != null ? (row.daily_rate_cents / 100).toFixed(2) : '');
      setFrom(data.today);
      setErr(null);
    }
  }, [row, data.today]);

  if (!row) return null;
  const value = parseAmount(amount);
  const cents = value != null ? Math.round(value * 100) : null;
  const hourly = cents != null ? cents / data.standard_hours : null;

  const save = async () => {
    if (value == null || value < 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.put<{ pending_payouts_refreshed: number }>(`/api/employees/${row.employee_id}/rate`, { daily_rate: value, effective_from: from });
      toast.success(`${row.preferred_name || row.full_name}: ${fmtMoney(cents!, data.currency)} a day${r.pending_payouts_refreshed ? ` · ${r.pending_payouts_refreshed} pending updated` : ''}`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title={row.full_name}
      description={[row.staff_id, row.job_title].filter(Boolean).join(' · ')}
      footer={editable ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" loading={busy} disabled={value == null || value < 0} onClick={() => void save()}>Save salary</Button>
        </>
      ) : undefined}
    >
      <div className="stack">
        {!editable && <Notice icon={Lock}>Only the owner can change salaries.</Notice>}
        <div className="field">
          <label className="field-label" htmlFor={amountId}>Daily salary · {data.standard_hours} hours</label>
          <div className="prefix-field">
            <span className="prefix" aria-hidden>RM</span>
            <Input id={amountId} className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
              disabled={!editable} data-autofocus aria-invalid={amount !== '' && value == null} aria-describedby={`${amountId}-ot`} />
          </div>
        </div>
        <div className="group plain" id={`${amountId}-ot`}>
          <div className="kv"><span className="k">Overtime per hour<small>Salary ÷ {data.standard_hours} hours</small></span><span className="v money">{hourly != null ? fmtMoney(Math.round(hourly), data.currency) : '—'}</span></div>
          <div className="kv"><span className="k">Example: {data.standard_hours + 2} h day<small>{data.standard_hours} h salary + 2 h overtime</small></span><span className="v money">{cents != null ? fmtMoney(cents + Math.round(hourly! * 2), data.currency) : '—'}</span></div>
        </div>
        {editable && (
          <div className="field">
            <label className="field-label" htmlFor={fromId}>Applies from</label>
            <Input id={fromId} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <div className="field-help">Days already paid never change. Pending days from this date are recalculated.</div>
          </div>
        )}
        {err && <InlineError>{err}</InlineError>}
        {hist.data && hist.data.rates.length > 0 && (
          <div>
            <div className="section-label">History</div>
            <div className="group plain">
              {hist.data.rates.map((h) => (
                <div key={h.effective_from} className="kv">
                  <span className="k">From {fmtYmd(h.effective_from)}<small>{h.set_by ? `Set by ${h.set_by}` : ''}</small></span>
                  <span className="v">{fmtMoney(h.daily_rate_cents, data.currency)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function SalariesPage() {
  const { can } = useAuth();
  const q = useQuery((s) => api.get<RatesResponse>('/api/payroll/rates', undefined, s), [], { tables: ['employees'] });
  const [open, setOpen] = useState<RateRow | null>(null);
  const d = q.data;
  const missing = d?.employees.filter((e) => e.daily_rate_cents == null).length ?? 0;

  return (
    <>
      <PageHead title="Salaries" lede={d ? `Day salary covers ${d.standard_hours} hours. Overtime per hour = salary ÷ ${d.standard_hours}.` : ' '} />
      {q.error && !d ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : (
        <div className="stack">
          {!can('payroll.rates') && <Notice icon={Lock}>You can view salaries. Only the owner can change them.</Notice>}
          {missing > 0 && can('payroll.rates') && <Notice tone="warning">{missing} staff member{missing === 1 ? ' has' : 's have'} no salary yet. Their check-outs can’t be paid until you set one.</Notice>}
          {!d ? (
            <div className="group">{[0, 1, 2, 3].map((i) => <div key={i} className="grow-row"><Skeleton w={36} h={36} r={18} /><div className="grow"><Skeleton w="45%" /></div><Skeleton w={70} /></div>)}</div>
          ) : d.employees.length === 0 ? (
            <div className="card card-pad"><EmptyState icon={Users} title="No active staff">Add staff first, then set their salaries here.</EmptyState></div>
          ) : (
            <div className="group">
              {d.employees.map((e) => (
                <button key={e.employee_id} type="button" className="grow-row" onClick={() => setOpen(e)}>
                  <Avatar name={e.full_name} employeeId={e.employee_id} hasPhoto={e.has_photo} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t truncate">{e.full_name}</div>
                    <div className="s truncate">
                      {e.daily_rate_cents != null ? `OT ${fmtMoney(Math.round(e.daily_rate_cents / d.standard_hours), d.currency)}/h` : 'Salary not set'}
                      {e.upcoming_rate_cents != null && e.upcoming_from ? ` · ${fmtMoney(e.upcoming_rate_cents, d.currency)} from ${fmtYmd(e.upcoming_from, { year: false })}` : ''}
                    </div>
                  </div>
                  <div className="end">
                    {e.daily_rate_cents != null
                      ? <span className="money" style={{ fontSize: 17 }}>{fmtMoney(e.daily_rate_cents, d.currency)}</span>
                      : <span className="status-chip review">Set salary</span>}
                    {e.daily_rate_cents != null && <span className="s" style={{ margin: 0 }}>per day</span>}
                  </div>
                  <ChevronRight className="chev" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {d && <RateSheet row={open} data={d} onClose={() => setOpen(null)} onSaved={q.reload} />}
    </>
  );
}
