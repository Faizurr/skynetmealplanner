import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
}

/** A table on desktop that becomes a list of cards on mobile (<768px). */
export function ResponsiveTable<T>({ rows, columns, rowKey, onRowClick, card, sort, onSort, caption }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  card: (r: T) => ReactNode;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  caption?: string;
}) {
  return (
    <div className="rtable">
      <div className="table-wrap">
        <table className="table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} className={c.className} scope="col" aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable && onSort ? (
                      <button type="button" className="th-sort" onClick={() => onSort(c.key)} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                        {c.header}
                        {active ? sort!.dir === 'asc' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden /> : <ChevronsUpDown aria-hidden />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={rowKey(r)}
                className={onRowClick ? 'clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } } : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rtable-cards">
        {rows.map((r) =>
          onRowClick ? (
            <button type="button" key={rowKey(r)} className="mcard" onClick={() => onRowClick(r)}>
              {card(r)}
            </button>
          ) : (
            <div key={rowKey(r)} className="mcard">
              {card(r)}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
