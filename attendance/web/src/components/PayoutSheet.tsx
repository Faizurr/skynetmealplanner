import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Banknote, Camera, CheckCircle2, ChevronLeft, Clock3, ImagePlus, QrCode, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Dialog } from './Dialog';
import { Avatar, Button, InlineError, Notice, TextArea, Input } from './ui';
import { useToast } from './Toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtDuration, fmtTime, fmtYmd } from '../lib/format';
import { fmtMoney, parseAmount } from '../lib/money';
import { compressImage } from '../lib/image';
import type { Payout } from '../lib/types';

type Step = 'detail' | 'cash' | 'qr' | 'later' | 'adjust' | 'reopen' | 'proof';

export function PayoutStatusChip({ p }: { p: Pick<Payout, 'status' | 'method' | 'needs_review' | 'rate_missing'> }) {
  if (p.status === 'void') return <span className="status-chip void">Cancelled</span>;
  if (p.status === 'paid') {
    return p.method === 'cash'
      ? <span className="status-chip cash"><Banknote aria-hidden />Cash</span>
      : <span className="status-chip qr"><QrCode aria-hidden />QR</span>;
  }
  if (p.rate_missing) return <span className="status-chip review">Set salary</span>;
  return <span className="status-chip pending"><Clock3 aria-hidden />Pending</span>;
}

/** Bottom sheet to settle one payout: Paid in cash (photo of payslip), Paid via QR, or keep pending. */
export function PayoutSheet({ payout, currency, open, onClose, onChanged, standardHours }: {
  payout: Payout | null; currency: string; open: boolean; onClose: () => void; onChanged: (p: Payout) => void; standardHours: number;
}) {
  const { me, can } = useAuth();
  const tz = me!.restaurant.timezone;
  const toast = useToast();
  const [step, setStep] = useState<Step>('detail');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [note, setNote] = useState('');
  const [adj, setAdj] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const adjId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setStep('detail');
      setPhoto(null);
      setNote(payout?.pay_note ?? '');
      setAdj(payout && payout.adjustment_cents ? String(payout.adjustment_cents / 100) : '');
      setReason('');
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payout?.id]);

  if (!payout) return null;
  const p = payout;
  const name = p.preferred_name || p.full_name;
  const hourly = p.daily_rate_cents / standardHours;
  const canPay = can('payroll.pay') && p.status === 'pending';

  const go = (s: Step) => {
    setErr(null);
    setStep(s);
  };

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    setErr(null);
    try {
      setPhoto(await compressImage(file));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function run(fn: () => Promise<Payout>, success: string) {
    setBusy(true);
    setErr(null);
    try {
      const updated = await fn();
      onChanged(updated);
      toast.success(success);
      if (updated.status === 'paid' || step === 'later') onClose();
      else go('detail');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const pay = (method: 'cash' | 'qr') =>
    run(
      () => api.post<Payout>(`/api/payouts/${p.id}/pay`, { method, photo_base64: photo, note: note.trim() || null }),
      method === 'cash' ? `Paid ${fmtMoney(p.total_cents, currency)} in cash to ${name}` : `Paid ${fmtMoney(p.total_cents, currency)} via QR to ${name}`,
    );

  const adjValue = parseAmount(adj);
  const newTotal = p.base_cents + p.ot_cents + Math.round((adjValue ?? 0) * 100);

  const hiddenInputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
    </>
  );

  const back = <Button variant="ghost" icon={ChevronLeft} onClick={() => go('detail')} disabled={busy}>Back</Button>;
  let body: ReactNode;
  let footer: ReactNode = null;
  let title: ReactNode = name;
  let description: ReactNode = `${fmtYmd(p.work_date, { weekday: true })} · ${fmtTime(p.check_in_at, tz)} – ${fmtTime(p.check_out_at, tz)}`;

  if (step === 'detail') {
    body = (
      <div className="stack">
        <div className="row" style={{ alignItems: 'center', gap: 14 }}>
          <Avatar name={p.full_name} employeeId={p.employee_id} hasPhoto={p.has_photo} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="money money-hero" aria-label={`Total ${fmtMoney(p.total_cents, currency)}`}>{p.rate_missing ? '—' : fmtMoney(p.total_cents, currency)}</div>
            <div className="row" style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
              <PayoutStatusChip p={p} />
              {p.needs_review && <span className="status-chip review"><AlertTriangle aria-hidden />Check</span>}
            </div>
          </div>
        </div>

        {p.rate_missing && (
          <Notice tone="warning" icon={AlertTriangle}>
            {name}’s daily salary isn’t set yet, so this day can’t be paid.{' '}
            {can('payroll.rates') ? <Link to="/salaries">Set salary</Link> : 'Ask the owner to set it.'}
          </Notice>
        )}
        {p.needs_review && <Notice tone="attention" icon={AlertTriangle}>{p.review_reason ?? 'Please check this payout.'}</Notice>}

        <div className="group" role="list" aria-label="Pay breakdown">
          <div className="kv" role="listitem"><span className="k">Day salary<small>{standardHours} hours</small></span><span className="v">{fmtMoney(p.base_cents, currency)}</span></div>
          <div className="kv" role="listitem"><span className="k">Worked</span><span className="v">{fmtDuration(p.worked_minutes)}</span></div>
          <div className="kv" role="listitem">
            <span className="k">Overtime<small>{p.ot_minutes > 0 ? `${fmtDuration(p.ot_minutes)} × ${fmtMoney(Math.round(hourly), currency)}/h` : `${fmtMoney(Math.round(hourly), currency)} per hour after ${standardHours} h`}</small></span>
            <span className="v">{fmtMoney(p.ot_cents, currency)}</span>
          </div>
          {p.adjustment_cents !== 0 && (
            <div className="kv" role="listitem"><span className="k">Adjustment<small>{p.adjustment_reason}</small></span><span className="v">{fmtMoney(p.adjustment_cents, currency, { sign: true })}</span></div>
          )}
          <div className="kv total" role="listitem"><span className="k">Total to pay</span><span className="v money">{fmtMoney(p.total_cents, currency)}</span></div>
        </div>

        {p.status === 'paid' && (
          <div className="group">
            <div className="grow-row">
              {p.has_proof ? (
                <button type="button" className="proof-thumb" onClick={() => go('proof')} aria-label="View payment proof photo">
                  <img src={`/api/payouts/${p.id}/proof`} alt="" />
                </button>
              ) : (
                <span className="proof-thumb" aria-hidden style={{ display: 'grid', placeItems: 'center' }}><QrCode style={{ width: 28, height: 28, color: 'var(--text-3)' }} /></span>
              )}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t strong">Paid {p.method === 'cash' ? 'in cash' : 'via QR'}</div>
                <div className="s">{p.paid_at ? fmtDateTime(p.paid_at, tz) : ''}{p.paid_by ? ` · by ${p.paid_by}` : ''}</div>
                {p.pay_note && <div className="s">“{p.pay_note}”</div>}
              </div>
            </div>
          </div>
        )}
        {p.status === 'pending' && p.pay_note && <Notice icon={Clock3}>Note: “{p.pay_note}”</Notice>}

        {canPay && !p.rate_missing && (
          <div className="stack-sm">
            <div className="section-label" style={{ padding: '4px 4px 2px' }}>How was it paid?</div>
            <div className="method-grid">
              <button type="button" className="method-btn cash" onClick={() => go('cash')}><Banknote aria-hidden />Cash<span className="sub">Photo of payslip</span></button>
              <button type="button" className="method-btn qr" onClick={() => go('qr')}><QrCode aria-hidden />QR<span className="sub">DuitNow / bank</span></button>
              <button type="button" className="method-btn later" onClick={() => go('later')}><Clock3 aria-hidden />Later<span className="sub">Keep pending</span></button>
            </div>
            <Button variant="ghost" icon={SlidersHorizontal} onClick={() => go('adjust')}>Adjust amount</Button>
          </div>
        )}
        {p.status === 'paid' && can('payroll.rates') && (
          <Button variant="danger-ghost" icon={RotateCcw} onClick={() => go('reopen')}>Undo payment</Button>
        )}
        {p.needs_review && can('payroll.pay') && (
          <Button icon={CheckCircle2} loading={busy} onClick={() => run(async () => { await api.post(`/api/payouts/${p.id}/resolve-review`); return { ...p, needs_review: false, review_reason: null }; }, 'Marked as checked')}>Mark as checked</Button>
        )}
        {err && <InlineError>{err}</InlineError>}
      </div>
    );
  } else if (step === 'cash' || step === 'qr') {
    const cash = step === 'cash';
    title = cash ? 'Paid in cash' : 'Paid via QR';
    description = `${fmtMoney(p.total_cents, currency)} to ${p.full_name}`;
    body = (
      <div className="stack">
        {hiddenInputs}
        {photo ? (
          <>
            <div className="proof-frame"><img src={photo} alt={cash ? 'Payslip photo preview' : 'Transfer screenshot preview'} /></div>
            <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
              <Button icon={Camera} onClick={() => cameraRef.current?.click()}>Retake</Button>
              <Button variant="ghost" onClick={() => setPhoto(null)}>Remove</Button>
            </div>
          </>
        ) : (
          <button type="button" className="camera-cta" onClick={() => (cash ? cameraRef : libraryRef).current?.click()} aria-busy={photoBusy || undefined}>
            {photoBusy ? <span className="spinner" /> : cash ? <Camera aria-hidden /> : <ImagePlus aria-hidden />}
            <span className="t">{cash ? 'Take a photo of the signed payslip' : 'Attach the transfer screenshot'}</span>
            <span className="small">{cash ? 'Required for cash payments' : 'Optional, but recommended'}</span>
          </button>
        )}
        {cash && !photo && <Button variant="ghost" icon={ImagePlus} onClick={() => libraryRef.current?.click()}>Choose from photos instead</Button>}
        <div className="field">
          <label className="field-label" htmlFor={noteId}>Note <span className="opt">(optional)</span></label>
          <Input id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder={cash ? 'e.g. Signed by staff' : 'e.g. Ref 9F21…'} maxLength={300} />
        </div>
        {err && <InlineError>{err}</InlineError>}
      </div>
    );
    footer = (
      <>
        {back}
        <Button variant="primary" size="lg" loading={busy} disabled={cash && !photo} onClick={() => void pay(cash ? 'cash' : 'qr')}>
          Confirm {fmtMoney(p.total_cents, currency)}
        </Button>
      </>
    );
  } else if (step === 'later') {
    title = 'Keep pending';
    description = 'It stays on the pending list until it’s paid.';
    body = (
      <div className="stack">
        <div className="field">
          <label className="field-label" htmlFor={noteId}>Note <span className="opt">(optional)</span></label>
          <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Will pay on Friday" maxLength={300} data-autofocus />
        </div>
        {err && <InlineError>{err}</InlineError>}
      </div>
    );
    footer = (
      <>
        {back}
        <Button variant="primary" size="lg" loading={busy} onClick={() => void run(() => api.post<Payout>(`/api/payouts/${p.id}/note`, { note: note.trim() }), 'Kept as pending')}>Save</Button>
      </>
    );
  } else if (step === 'adjust') {
    title = 'Adjust amount';
    description = 'Add a bonus or deduct an advance. Use a minus sign to deduct.';
    body = (
      <div className="stack">
        <div className="field">
          <label className="field-label" htmlFor={adjId}>Adjustment ({currency})</label>
          <Input id={adjId} className="amount-input" inputMode="decimal" value={adj} onChange={(e) => setAdj(e.target.value)} placeholder="0.00" data-autofocus aria-invalid={adj !== '' && adjValue == null} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={reasonId}>Reason</label>
          <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Salary advance on Monday" maxLength={200} />
        </div>
        <div className="group plain">
          <div className="kv total"><span className="k">New total</span><span className="v money">{fmtMoney(Math.max(0, newTotal), currency)}</span></div>
        </div>
        {err && <InlineError>{err}</InlineError>}
      </div>
    );
    footer = (
      <>
        {back}
        <Button variant="primary" size="lg" loading={busy} disabled={adjValue == null || reason.trim().length < 3}
          onClick={() => void run(() => api.post<Payout>(`/api/payouts/${p.id}/adjust`, { adjustment: adjValue, reason: reason.trim() }), 'Amount adjusted')}>
          Save
        </Button>
      </>
    );
  } else if (step === 'reopen') {
    title = 'Undo payment';
    description = 'Moves this payout back to pending. The photo is kept for the record.';
    body = (
      <div className="stack">
        <div className="field">
          <label className="field-label" htmlFor={reasonId}>Reason</label>
          <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Marked paid by mistake" maxLength={200} data-autofocus />
        </div>
        {err && <InlineError>{err}</InlineError>}
      </div>
    );
    footer = (
      <>
        {back}
        <Button variant="danger" size="lg" loading={busy} disabled={reason.trim().length < 3}
          onClick={() => void run(() => api.post<Payout>(`/api/payouts/${p.id}/reopen`, { reason: reason.trim() }), 'Payment undone')}>
          Undo payment
        </Button>
      </>
    );
  } else {
    title = 'Payment proof';
    description = `${p.method === 'cash' ? 'Cash' : 'QR'} · ${p.paid_at ? fmtDateTime(p.paid_at, tz) : ''}`;
    body = (
      <div className="stack">
        <div className="proof-frame" style={{ maxHeight: '70dvh' }}><img src={`/api/payouts/${p.id}/proof`} alt={`Payment proof for ${p.full_name}`} /></div>
        <a className="btn btn-block" href={`/api/payouts/${p.id}/proof`} target="_blank" rel="noreferrer">Open full size</a>
      </div>
    );
    footer = back;
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} footer={footer}>
      {body}
    </Dialog>
  );
}
