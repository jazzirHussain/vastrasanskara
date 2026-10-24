import { useMediaQuery } from '@mantine/hooks';

export const PHONE_QUERY = '(max-width: 47.99em)';

const activate = (onRowClick, row) =>
  onRowClick && {
    tabIndex: 0,
    onClick: () => onRowClick(row),
    onKeyDown: (e) => {
      if (e.key === 'Enter') onRowClick(row);
    },
  };

/**
 * One list, two layouts: a table from 768 px, stacked rows below. `columns` are
 * { key, header, render(row), align?, primary?, hideOnPhone? }; the primary column leads each
 * stacked row, the others follow as "Header: value".
 */
export function ResponsiveTable({ columns, rows, rowKey, onRowClick, label }) {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });

  if (phone) {
    const primary = columns.find((c) => c.primary) ?? columns[0];
    const rest = columns.filter((c) => c !== primary && !c.hideOnPhone && c.header);
    return (
      <div className="vs-stack" role="list" aria-label={label}>
        {rows.map((row) => (
          <div key={rowKey(row)} role="listitem" className="vs-stack-row vs-row" {...activate(onRowClick, row)}>
            <div style={{ fontWeight: 600 }}>{primary.render(row)}</div>
            {rest.map((c) => (
              <div key={c.key} style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--vs-muted)', minWidth: 84 }}>{c.header}</span>
                <span>{c.render(row)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <table className="vs-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="vs-row" {...activate(onRowClick, row)}>
            {columns.map((c) => (
              <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
