import { Text } from '@mantine/core';
import './chartTokens.css';

/**
 * Horizontal bars in one hue, largest first, each with its value written beside the label (in
 * text colour, not the bar's). Each row is a 44 px tap target; `onSelect(key)` opens its list.
 */
export function HBars({ label, rows, onSelect }) {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const max = Math.max(1, ...sorted.map((r) => r.value));
  return (
    <div role="group" aria-label={label}>
      {sorted.map((r) => (
        <button key={r.key} type="button" className="vs-hbar-row" aria-label={`${r.label}: ${r.display}`} onClick={() => onSelect?.(r.key)}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Text span size="sm">
              {r.label}
            </Text>
            <Text span size="sm" c="var(--vs-muted)" className="vs-figures">
              {r.display}
            </Text>
          </span>
          <span className="vs-hbar-track" aria-hidden>
            <span data-hbar="" className="vs-hbar-fill" style={{ display: 'block', width: `${(r.value / max) * 100}%`, minWidth: '2px' }} />
          </span>
        </button>
      ))}
    </div>
  );
}
