import type { LeaderboardResponse } from './types';
import { fmtYmd } from './format';

/**
 * Renders the leaderboard as a 1080×1350 (4:5) PNG, styled like an iOS share card:
 * deep gradient backdrop, frosted-glass panels, podium with medal rings. Contains names and points
 * only — never pay information.
 */
export const CARD_W = 1080;
export const CARD_H = 1350;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif';
const ROUNDED = 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif';
const MEDALS = ['#f5b800', '#b8bec8', '#d08350'];

export function periodLabel(d: Pick<LeaderboardResponse, 'period' | 'from' | 'to'>): string {
  const name = d.period === 'week' ? 'Last 7 days' : d.period === 'month' ? 'This month' : d.period === 'last_month' ? 'Last month' : 'Custom';
  return `${name} · ${fmtYmd(d.from, { year: false })} – ${fmtYmd(d.to, { year: false })}`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function glass(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.04)');
  g.addColorStop(1, 'rgba(255,255,255,0.02)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.stroke();
  ctx.restore();
}

function avatar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, name: string, ring: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 9, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1f4a';
  ctx.fill();
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  g.addColorStop(0, '#5e9bff');
  g.addColorStop(1, '#7b5cff');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(r * 0.72)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(name), cx, cy + 2);
  ctx.restore();
}

function crown(ctx: CanvasRenderingContext2D, cx: number, y: number, w: number) {
  const h = w * 0.62;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, y + h);
  ctx.lineTo(cx - w / 2, y + h * 0.25);
  ctx.lineTo(cx - w / 4, y + h * 0.6);
  ctx.lineTo(cx, y);
  ctx.lineTo(cx + w / 4, y + h * 0.6);
  ctx.lineTo(cx + w / 2, y + h * 0.25);
  ctx.lineTo(cx + w / 2, y + h);
  ctx.closePath();
  ctx.fillStyle = MEDALS[0];
  ctx.shadowColor = 'rgba(245,184,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.fill();
  ctx.restore();
}

export function drawLeaderboard(canvas: HTMLCanvasElement, d: LeaderboardResponse): void {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d')!;
  // Backdrop
  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, '#0b1d5c');
  bg.addColorStop(0.55, '#2a1f8f');
  bg.addColorStop(1, '#0a0f2e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  for (const [x, y, r, c] of [[160, 140, 420, 'rgba(64,156,255,0.55)'], [980, 420, 380, 'rgba(175,82,222,0.45)'], [420, 1250, 460, 'rgba(10,132,255,0.35)']] as const) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(fit(ctx, d.restaurant.toUpperCase(), 900), 72, 104);
  ctx.fillStyle = '#fff';
  ctx.font = `800 88px ${FONT}`;
  ctx.fillText('Leaderboard', 68, 196);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `500 34px ${FONT}`;
  ctx.fillText(periodLabel(d), 72, 252);

  // Podium
  const top = d.rows.slice(0, 3);
  const slots = [
    { i: 1, cx: 250, step: 120, r: 74 },
    { i: 0, cx: 540, step: 170, r: 92 },
    { i: 2, cx: 830, step: 90, r: 74 },
  ];
  // Header ends ~y=252; the crown of #1 starts at ~336, so nothing overlaps the title or dates.
  const baseY = 880;
  for (const s of slots) {
    const row = top[s.i];
    const w = 236;
    const x = s.cx - w / 2;
    const y = baseY - s.step;
    ctx.save();
    rr(ctx, x, y, w, s.step + 40, 30);
    const sg = ctx.createLinearGradient(0, y, 0, y + s.step);
    sg.addColorStop(0, row ? MEDALS[s.i] : 'rgba(255,255,255,0.15)');
    sg.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.globalAlpha = row ? 0.55 : 0.4;
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `800 64px ${ROUNDED}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(s.i + 1), s.cx, y + Math.min(76, s.step - 8));
    ctx.restore();
    if (!row) continue;
    const ay = y - s.r - 120;
    if (s.i === 0) crown(ctx, s.cx, ay - s.r - 70, 76);
    avatar(ctx, s.cx, ay, s.r, row.full_name, MEDALS[s.i]);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText(fit(ctx, row.preferred_name || row.full_name.split(' ')[0], 250), s.cx, ay + s.r + 58);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `700 30px ${ROUNDED}`;
    ctx.fillText(`${row.points} pts`, s.cx, ay + s.r + 98);
  }

  // Rest of the table
  const MAX_REST = 4;
  const overflow = d.rows.length - 3 > MAX_REST;
  const rest = d.rows.slice(3, 3 + (overflow ? MAX_REST - 1 : MAX_REST));
  const more = Math.max(0, d.rows.length - 3 - rest.length);
  const panelY = 950;
  const rowH = 70;
  const panelH = Math.max(1, rest.length + (more ? 1 : 0)) * rowH + 28;
  glass(ctx, 60, panelY, CARD_W - 120, panelH, 36);
  if (!rest.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `500 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(d.rows.length ? 'Keep it up, team!' : 'No attendance yet in this period', CARD_W / 2, panelY + 62);
  }
  rest.forEach((r, k) => {
    const y = panelY + 14 + k * rowH;
    if (k > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(110, y, CARD_W - 220, 2);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `700 32px ${ROUNDED}`;
    ctx.fillText(String(r.rank), 104, y + 48);
    ctx.fillStyle = '#fff';
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(fit(ctx, r.full_name, 560), 170, y + 48);
    ctx.textAlign = 'right';
    ctx.font = `700 32px ${ROUNDED}`;
    ctx.fillText(`${r.points}`, CARD_W - 104, y + 48);
  });
  if (more > 0) {
    const y = panelY + 14 + rest.length * rowH;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(110, y, CARD_W - 220, 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = `500 28px ${FONT}`;
    ctx.fillText(`+ ${more} more on the team`, CARD_W / 2, y + 46);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `500 26px ${FONT}`;
  const p = d.points;
  ctx.fillText(`+${p.onTime} on time · +${p.dayWorked} per day · ${p.late} late · ${p.missingCheckout} missed check-out`, CARD_W / 2, CARD_H - 48);
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'));
}

export function leaderboardText(d: LeaderboardResponse): string {
  const medal = ['🥇', '🥈', '🥉'];
  const lines = d.rows.slice(0, 10).map((r) => `${medal[r.rank - 1] ?? `${r.rank}.`} ${r.preferred_name || r.full_name} — ${r.points} pts`);
  return [`🏆 ${d.restaurant} leaderboard`, periodLabel(d), '', ...lines].join('\n');
}
