import {
  IconAddressBook,
  IconAdjustmentsHorizontal,
  IconHome2,
  IconNeedleThread,
  IconPlus,
  IconTool,
  IconUsersGroup,
} from '@tabler/icons-react';

/**
 * Main navigation. `permission` hides an item from users without it. On phones, `phone` places
 * it in the bottom bar ('bar'), as the raised centre button ('primary') or under More ('more').
 */
export const navItems = [
  { label: 'Home', path: '/', icon: IconHome2, phone: 'bar' },
  { label: 'Orders', path: '/orders', permission: 'orders.read.own', icon: IconNeedleThread, phone: 'bar' },
  { label: 'New order', path: '/orders/new', permission: 'orders.write', icon: IconPlus, phone: 'primary' },
  { label: 'Customers', path: '/customers', permission: 'customers.read', icon: IconAddressBook, phone: 'bar' },
  { label: 'Workshop', path: '/workshop', permission: 'workshop.manage', icon: IconTool, phone: 'more' },
  { label: 'Users', path: '/users', permission: 'users.manage', icon: IconUsersGroup, phone: 'more' },
  { label: 'Settings', path: '/settings', permission: 'settings.edit', icon: IconAdjustmentsHorizontal, phone: 'more' },
];

/** The item the current page belongs to: the longest path that the location starts with. */
export function activePath(items, pathname) {
  const matches = items.filter((i) => i.path === pathname || (i.path !== '/' && pathname.startsWith(`${i.path}/`)));
  return matches.sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null;
}
