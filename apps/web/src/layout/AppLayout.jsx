import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMediaQuery } from '@mantine/hooks';
import { useAuth } from '../auth/AuthContext.js';
import { PHONE_QUERY } from '../components/ResponsiveTable.jsx';
import { NotificationBell } from '../notifications/NotificationBell.jsx';
import { BottomBar } from './BottomBar.jsx';
import { activePath, navItems } from './navItems.js';
import { Sidebar } from './Sidebar.jsx';

/** Desktop: indigo sidebar and a content column. Phone: top bar with the bell, bottom bar. */
export function AppLayout() {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const items = navItems.filter((item) => !item.permission || can(item.permission));
  const active = activePath(items, location.pathname);

  if (phone) {
    return (
      <div className="vs-main-phone">
        <header className="vs-topbar">
          <Link to="/" className="vs-brand">
            Vastrasanskara
          </Link>
          <NotificationBell />
        </header>
        <main className="vs-content">
          <Outlet />
        </main>
        <BottomBar items={items} active={active} user={user} onLogout={handleLogout} />
      </div>
    );
  }

  return (
    <>
      <Sidebar items={items} active={active} user={user} onLogout={handleLogout} />
      <main className="vs-main">
        <div className="vs-content">
          <Outlet />
        </div>
      </main>
    </>
  );
}
