import {
  forwardRef, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, type CSSProperties,
} from 'react';
import { AlertCircle, Info, RefreshCw, type LucideIcon } from 'lucide-react';
import type { StatusInfo, Tone } from '../lib/status';
import { initials } from '../lib/format';

/* ------------------------------------------------------------ Button */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: LucideIcon;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon: Icon, block, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', variant !== 'secondary' && `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : Icon ? <Icon aria-hidden /> : null}
      {children}
    </button>
  );
});

export function IconButton({ label, icon: Icon, size = 'md', variant = 'ghost', className = '', ...rest }: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: LucideIcon }) {
  return (
    <Button variant={variant} size={size} className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon aria-hidden />
    </Button>
  );
}

/* ------------------------------------------------------------ Card */
export function Card({ title, hint, actions, children, className = '', pad, footer, id }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; pad?: boolean; footer?: ReactNode; id?: string }) {
  return (
    <section className={`card ${className}`} aria-labelledby={title && id ? `${id}-t` : undefined} id={id}>
      {(title || actions) && (
        <header className="card-head">
          <div className="grow">
            {title && <h2 id={id ? `${id}-t` : undefined}>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {pad ? <div className="card-pad">{children}</div> : children}
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

/* ------------------------------------------------------------ Pills */
export function Pill({ tone = 'neutral', children, dot = true, title, className = '' }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string; className?: string }) {
  return (
    <span className={`pill tone-${tone} ${className}`} title={title}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

export function StatusPill({ info, dot = true }: { info: StatusInfo; dot?: boolean }) {
  return (
    <Pill tone={info.tone} dot={dot} title={info.hint}>
      {info.label}
    </Pill>
  );
}

export function Direction({ type }: { type: 'check_in' | 'check_out' }) {
  return <span className={`dir ${type === 'check_in' ? 'dir-in' : 'dir-out'}`}>{type === 'check_in' ? 'CHECK IN' : 'CHECK OUT'}</span>;
}

/* ------------------------------------------------------------ Form fields */
export function Field({ label, help, error, optional, children, htmlFor, className = '', warn }: { label: ReactNode; help?: ReactNode; error?: string | null; optional?: boolean; children: ReactNode; htmlFor?: string; className?: string; warn?: ReactNode }) {
  return (
    <div className={`field ${className}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {optional && <span className="opt">(optional)</span>}
      </label>
      {children}
      {warn && (
        <div className="field-warn" role="status">
          <AlertCircle aria-hidden />
          <span>{warn}</span>
        </div>
      )}
      {error ? <div className="field-error" role="alert">{error}</div> : help ? <div className="field-help">{help}</div> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`input ${className}`} {...rest} />;
});

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

/** Labelled text input in one go. */
export function TextField({ label, help, error, optional, id, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; help?: ReactNode; error?: string | null; optional?: boolean }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} help={help} error={error} optional={optional} htmlFor={fid} className={className}>
      <Input id={fid} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="switch-row">
      <div className="switch-text">
        <div className="t" id={`${fid}-l`}>{label}</div>
        {description && <div className="d" id={`${fid}-d`}>{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        id={fid}
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${fid}-l`}
        aria-describedby={description ? `${fid}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function SegmentedControl<T extends string>({ value, onChange, options, label, block }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; block?: boolean }) {
  return (
    <div className={`segmented ${block ? 'block' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" type="button" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ States */
export function EmptyState({ icon: Icon = Info, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon aria-hidden /></div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty error-state" role="alert">
      <div className="empty-icon"><AlertCircle aria-hidden /></div>
      <h3>Couldn’t load this</h3>
      <p>{message}</p>
      {onRetry && (
        <Button icon={RefreshCw} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="inline-error" role="alert">
      <AlertCircle aria-hidden />
      <span>{children}</span>
    </div>
  );
}

export function Notice({ tone, icon: Icon = Info, children }: { tone?: 'warning' | 'attention' | 'info'; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className={`notice ${tone ?? ''}`}>
      <Icon aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return <span className="skel" aria-hidden style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />;
}

export function SkeletonRows({ rows = 5, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          {avatar && <Skeleton w={36} h={36} r={18} />}
          <div className="grow stack-sm">
            <Skeleton w={`${55 - (i % 3) * 10}%`} h={12} />
            <Skeleton w={`${30 + (i % 2) * 12}%`} h={10} />
          </div>
          <Skeleton w={56} h={20} r={10} />
        </div>
      ))}
    </div>
  );
}

export function InfoTip({ children, label = 'More info', align }: { children: ReactNode; label?: string; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className={`info-tip ${align ? `align-${align}` : ''}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        <Info aria-hidden />
      </button>
      {open && (
        <span role="tooltip" id={id}>
          {children}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------ Avatar */
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, employeeId, hasPhoto, size = 'md' }: { name: string; employeeId?: string; hasPhoto?: boolean; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [failed, setFailed] = useState(false);
  const showPhoto = hasPhoto && employeeId && !failed;
  return (
    <span className={`avatar ${size !== 'md' ? `avatar-${size}` : ''}`} style={{ '--av-h': hue(name || '?') } as CSSProperties} aria-hidden>
      {showPhoto ? <img src={`/api/employees/${employeeId}/photo`} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials(name)}
    </span>
  );
}

export function Person({ name, sub, employeeId, hasPhoto, size }: { name: string; sub?: ReactNode; employeeId?: string; hasPhoto?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className="person">
      <Avatar name={name} employeeId={employeeId} hasPhoto={hasPhoto} size={size} />
      <span className="grow">
        <span className="person-name truncate" style={{ display: 'block' }}>{name}</span>
        {sub && <span className="person-sub truncate" style={{ display: 'block' }}>{sub}</span>}
      </span>
    </span>
  );
}

export function PageHead({ title, lede, actions }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
