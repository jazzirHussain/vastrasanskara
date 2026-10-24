import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Burger, Button, Group, NavLink, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useAuth } from '../auth/AuthContext.js';
import { NotificationBell } from '../notifications/NotificationBell.jsx';
import { navItems } from './navItems.js';

/** Header (burger on phones, bell, logout) + permission-filtered sidebar + page. */
export function AppLayout() {
  const { can, logout } = useAuth();
  const [navOpen, { toggle, close }] = useDisclosure(false);
  const location = useLocation();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const links = navItems.filter((item) => !item.permission || can(item.permission));

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !navOpen } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={navOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Text fw={700}>Vastrasanskara</Text>
          </Group>
          <Group gap="xs">
            <NotificationBell />
            <Button variant="subtle" onClick={handleLogout}>
              Log out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {links.map((item) => (
          <NavLink
            key={item.path}
            component={Link}
            to={item.path}
            label={item.label}
            active={location.pathname === item.path}
            onClick={close}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
