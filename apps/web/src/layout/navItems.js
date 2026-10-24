// Sidebar links; `permission` hides a link from users without it. Later milestones append items.
export const navItems = [
  { label: 'Home', path: '/' },
  { label: 'Users', path: '/users', permission: 'users.manage' },
  { label: 'Settings', path: '/settings', permission: 'settings.edit' },
];
