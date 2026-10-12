import { useId } from 'react';
import { addDaysYmd } from '../lib/format';
import { SegmentedControl } from './ui';

export type Preset = '7d' | '30d' | '90d' | 'month' | 'custom';
export interface Range {
  preset: Preset;
  from: string;
  to: string;
}

export function rangeForPreset(p: Preset, today: string, current?: Range): Range {
  switch (p) {
    case '7d':
      return { preset: p, from: addDaysYmd(today, -6), to: today };
    case '30d':
      return { preset: p, from: addDaysYmd(today, -29), to: today };
    case '90d':
      return { preset: p, from: addDaysYmd(today, -89), to: today };
    case 'month':
      return { preset: p, from: `${today.slice(0, 8)}01`, to: today };
    default:
      return { preset: 'custom', from: current?.from ?? addDaysYmd(today, -6), to: current?.to ?? today };
  }
}

/** Simple range picker: presets + custom from/to (native date inputs, great on iOS). */
export function DateRangePicker({ value, onChange, today, presets = ['7d', '30d', '90d', 'month', 'custom'] }: { value: Range; onChange: (r: Range) => void; today: string; presets?: Preset[] }) {
  const id = useId();
  const labels: Record<Preset, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', month: 'This month', custom: 'Custom' };
  return (
    <div className="stack-sm" style={{ minWidth: 0 }}>
      <SegmentedControl label="Date range" value={value.preset} onChange={(p) => onChange(rangeForPreset(p, today, value))} options={presets.map((p) => ({ value: p, label: labels[p] }))} />
      {value.preset === 'custom' && (
        <div className="row-wrap">
          <label className="sr-only" htmlFor={`${id}-f`}>From</label>
          <input id={`${id}-f`} className="input" style={{ width: 'auto', flex: '1 1 140px' }} type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          <span className="subtle small">to</span>
          <label className="sr-only" htmlFor={`${id}-t`}>To</label>
          <input id={`${id}-t`} className="input" style={{ width: 'auto', flex: '1 1 140px' }} type="date" value={value.to} min={value.from} max={today} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}
