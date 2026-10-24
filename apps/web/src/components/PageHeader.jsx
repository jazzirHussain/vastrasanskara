import { Group } from '@mantine/core';

/** Page title (in the display face) on the left, the page's main action on the right. */
export function PageHeader({ title, action, children }) {
  return (
    <Group justify="space-between" align="flex-end" gap="md" mb={24} wrap="wrap">
      <div style={{ minWidth: 0 }}>
        <h1 className="vs-display" style={{ margin: 0, fontSize: 'clamp(26px, 4vw, 32px)', lineHeight: 1.15, color: 'var(--vs-ink)' }}>
          {title}
        </h1>
        {children && <div style={{ marginTop: 6, color: 'var(--vs-muted)' }}>{children}</div>}
      </div>
      {action}
    </Group>
  );
}
