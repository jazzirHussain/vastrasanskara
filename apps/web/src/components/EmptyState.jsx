/** What to do when a list is empty: a short stitch ending in a knot, the title, the next step. */
export function EmptyState({ title, body, action }) {
  return (
    <div className="vs-panel" style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <svg width="72" height="12" viewBox="0 0 72 12" aria-hidden="true">
        <line x1="2" y1="6" x2="62" y2="6" stroke="var(--vs-rule)" strokeWidth="2" strokeDasharray="5 4" />
        <circle cx="66" cy="6" r="4" fill="var(--vs-haldi)" />
      </svg>
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h3>
      {body && <p style={{ margin: 0, color: 'var(--vs-muted)', maxWidth: '60ch' }}>{body}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
