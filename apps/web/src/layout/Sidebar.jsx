import { Link } from 'react-router-dom';
import { Group, Text, UnstyledButton } from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { NotificationBell } from '../notifications/NotificationBell.jsx';

/** The brand's short running stitch with a knot, under the name. */
export function BrandStitch({ color = 'rgba(244, 245, 249, 0.5)', knot = 'var(--vs-haldi)' }) {
  return (
    <svg className="vs-brand-stitch" width="96" height="8" viewBox="0 0 96 8" aria-hidden="true">
      <line x1="1" y1="4" x2="86" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray="5 4" />
      <circle cx="91" cy="4" r="3.5" fill={knot} />
    </svg>
  );
}

/** Desktop navigation: indigo column with the pages, the bell, the user and Log out. */
export function Sidebar({ items, active, user, onLogout }) {
  return (
    <aside className="vs-sidebar">
      <Link to="/" className="vs-brand">
        Vastrasanskara
        <BrandStitch />
      </Link>
      <nav aria-label="Main" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map(({ path, label, icon: Icon }) => (
          <Link key={path} to={path} className="vs-nav-link" aria-current={active === path ? 'page' : undefined}>
            <Icon size={20} stroke={1.6} aria-hidden="true" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="vs-sidebar-footer">
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" fw={600} c="var(--vs-chalk)" truncate>
            {user.name}
          </Text>
          <NotificationBell tone="light" />
        </Group>
        <UnstyledButton className="vs-nav-link" onClick={onLogout} style={{ padding: '6px 0' }}>
          <IconLogout size={18} stroke={1.6} aria-hidden="true" />
          Log out
        </UnstyledButton>
      </div>
    </aside>
  );
}
