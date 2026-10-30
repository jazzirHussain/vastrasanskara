const STATUSES = {
  active: ['Active', 'indigo'],
  on_hold: ['On hold', 'haldi'],
  completed: ['Completed', 'neem'],
  cancelled: ['Cancelled', 'muted'],
  in_progress: ['In progress', 'indigo'],
  ready: ['Ready', 'neem'],
  picked_up: ['Picked up', 'neem'],
  rejected: ['Rejected', 'kumkum'],
  rush: ['Rush', 'kumkum'],
  late: ['Late', 'kumkum'],
  tight: ['Tight schedule', 'haldi'],
  inactive: ['Inactive', 'muted'],
  batch: ['Batch', 'indigo'],
  with_vendor: ['With vendor', 'haldi'],
  alteration: ['Alteration open', 'haldi'],
  draft: ['Draft', 'muted'],
  unpaid: ['Unpaid', 'haldi'],
  part_paid: ['Part paid', 'haldi'],
  paid: ['Paid', 'neem'],
  overdue: ['Overdue', 'kumkum'],
};

const TINTS = {
  indigo: ['var(--vs-indigo)', '#EEEFF7'],
  haldi: ['#875C0C', '#FCF5E6'],
  neem: ['var(--vs-neem)', '#EBF4EE'],
  kumkum: ['var(--vs-kumkum)', '#FBEDEF'],
  muted: ['var(--vs-muted)', '#EEEFF4'],
};

/** Order, garment and bill statuses and flags (rush, late, tight), coloured by meaning. */
export function StatusBadge({ status, label }) {
  const [text, tone] = STATUSES[status] ?? [status, 'muted'];
  const [color, background] = TINTS[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px 2px 7px',
        borderRadius: 6,
        background,
        color,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label ?? text}
    </span>
  );
}
