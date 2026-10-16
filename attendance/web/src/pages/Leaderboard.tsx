import { Fragment, useEffect, useRef, useState } from 'react';
import { Award, Clock, Copy, Crown, Download, Flame, Share, Trophy } from 'lucide-react';
import { api } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { fmtHours } from '../lib/format';
import type { LeaderboardResponse, LeaderRow } from '../lib/types';
import { canvasToBlob, drawLeaderboard, leaderboardText, periodLabel } from '../lib/shareCard';
import { Avatar, Button, EmptyState, ErrorState, PageHead, SegmentedControl, Skeleton } from '../components/ui';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';

type Period = 'week' | 'month' | 'last_month';

function firstName(r: LeaderRow) {
  return r.preferred_name || r.full_name.split(' ')[0];
}

function Podium({ rows }: { rows: LeaderRow[] }) {
  const order = [rows[1], rows[0], rows[2]];
  const cls = ['p2', 'p1', 'p3'];
  return (
    <div className="podium" role="list" aria-label="Top three">
      {order.map((r, i) => (
        <div key={cls[i]} className={`podium-col ${cls[i]}`} role="listitem" aria-label={r ? `${r.rank === 1 ? 'First' : r.rank === 2 ? 'Second' : 'Third'}: ${r.full_name}, ${r.points} points` : undefined}>
          {r ? (
            <>
              {cls[i] === 'p1' && <Crown className="crown" aria-hidden />}
              <Avatar name={r.full_name} employeeId={r.employee_id} hasPhoto={r.has_photo} size={cls[i] === 'p1' ? 'lg' : 'md'} />
              <div className="name">{firstName(r)}</div>
              <div className="pts">{r.points} pts</div>
            </>
          ) : (
            <div className="pts" style={{ opacity: 0.4 }}>—</div>
          )}
          <div className="podium-step" aria-hidden>{cls[i] === 'p1' ? 1 : cls[i] === 'p2' ? 2 : 3}</div>
        </div>
      ))}
    </div>
  );
}

function ShareSheet({ data, open, onClose }: { data: LeaderboardResponse; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const c = document.createElement('canvas');
    drawLeaderboard(c, data);
    canvasRef.current = c;
    setUrl(c.toDataURL('image/png'));
  }, [open, data]);

  const fileName = `leaderboard-${data.from}-to-${data.to}.png`;
  const share = async () => {
    if (!canvasRef.current) return;
    setBusy(true);
    try {
      const blob = await canvasToBlob(canvasRef.current);
      const file = new File([blob], fileName, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: 'Leaderboard', text: `${data.restaurant} leaderboard · ${periodLabel(data)}` });
      } else {
        download(blob);
        toast.info('Image saved. Share it from your downloads or photos.');
      }
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const download = (blob: Blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(leaderboardText(data));
      toast.success('Copied — paste it into WhatsApp or anywhere');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Share leaderboard" description="An image with names and points only. No pay details."
      footer={
        <>
          <Button icon={Copy} onClick={() => void copy()}>Copy text</Button>
          <Button variant="primary" size="lg" icon={Share} loading={busy} onClick={() => void share()}>Share image</Button>
        </>
      }>
      <div className="stack">
        {url ? <img className="share-preview" src={url} alt="Leaderboard image preview" /> : <Skeleton h={420} r={22} />}
        <Button variant="ghost" icon={Download} onClick={() => canvasRef.current && void canvasToBlob(canvasRef.current).then(download)}>Save image</Button>
      </div>
    </Dialog>
  );
}

export function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [sharing, setSharing] = useState(false);
  const q = useQuery((s) => api.get<LeaderboardResponse>('/api/leaderboard', { period }, s), [period], { tables: ['attendance_sessions'] });
  const d = q.data;
  const byId = new Map(d?.rows.map((r) => [r.employee_id, r]) ?? []);
  const awardIcon = { punctual: Clock, hours: Award, streak: Flame } as const;
  const awardTone = { punctual: 'var(--success-dot)', hours: 'var(--info-dot)', streak: 'var(--warning-dot)' } as const;

  return (
    <>
      <PageHead
        title="Leaderboard"
        lede={d ? periodLabel(d) : ' '}
        actions={<Button variant="primary" icon={Share} disabled={!d || d.rows.length === 0} onClick={() => setSharing(true)}>Share</Button>}
      />
      <div className="stack">
        <SegmentedControl<Period> label="Period" block value={period} onChange={setPeriod}
          options={[{ value: 'week', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'last_month', label: 'Last month' }]} />

        {q.error && !d ? (
          <ErrorState message={q.error} onRetry={q.reload} />
        ) : !d ? (
          <div className="card card-pad"><Skeleton h={220} r={18} /></div>
        ) : d.rows.length === 0 ? (
          <div className="card card-pad"><EmptyState icon={Trophy} title="No attendance in this period">Points appear as soon as staff start checking in.</EmptyState></div>
        ) : (
          <>
            <section className="card card-pad" aria-label="Podium"><Podium rows={d.rows} /></section>

            {d.awards.length > 0 && (
              <div className="award-row">
                {d.awards.map((a) => {
                  const Icon = awardIcon[a.id];
                  const r = byId.get(a.employee_id);
                  return (
                    <div key={a.id} className="award">
                      <span className="ico" style={{ background: `color-mix(in srgb, ${awardTone[a.id]} 18%, transparent)`, color: awardTone[a.id] }}><Icon aria-hidden /></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="t">{a.title}</div>
                        <div className="n">{r ? firstName(r) : ''} · {a.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <section aria-label="Rankings">
              <div className="section-label">Rankings</div>
              <div className="group" role="list">
                {d.rows.map((r) => (
                  <div key={r.employee_id} className="grow-row" role="listitem">
                    <span className="rank-badge" aria-label={`Rank ${r.rank}`}>{r.rank}</span>
                    <Avatar name={r.full_name} employeeId={r.employee_id} hasPhoto={r.has_photo} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="t truncate">{r.full_name}</div>
                      <div className="s wrap">
                        {[
                          `${r.days_worked} day${r.days_worked === 1 ? '' : 's'}`,
                          fmtHours(r.worked_minutes),
                          r.punctuality_rate != null ? `${r.punctuality_rate}% on time` : null,
                          r.streak >= 2 ? `🔥 ${r.streak}-day streak` : null,
                        ].filter(Boolean).map((t, i) => (
                          <Fragment key={i}>{i > 0 ? ' · ' : ''}<span className="seg">{t}</span></Fragment>
                        ))}
                      </div>
                    </div>
                    <div className="end"><span className="money" style={{ fontSize: 20 }}>{r.points}</span><span className="s" style={{ margin: 0 }}>pts</span></div>
                  </div>
                ))}
              </div>
            </section>

            <section aria-label="How points work">
              <div className="section-label">How points work</div>
              <div className="group plain">
                <div className="kv"><span className="k">On-time arrival</span><span className="v">+{d.points.onTime}</span></div>
                <div className="kv"><span className="k">Each day worked</span><span className="v">+{d.points.dayWorked}</span></div>
                <div className="kv"><span className="k">Late arrival</span><span className="v">{d.points.late}</span></div>
                <div className="kv"><span className="k">Missed check-out</span><span className="v">{d.points.missingCheckout}</span></div>
              </div>
            </section>
          </>
        )}
      </div>
      {d && <ShareSheet data={d} open={sharing} onClose={() => setSharing(false)} />}
    </>
  );
}
