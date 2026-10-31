import {
  IconAddressBook,
  IconAdjustmentsHorizontal,
  IconBuildingBank,
  IconHome2,
  IconLayoutKanban,
  IconNeedleThread,
  IconPlus,
  IconReceipt2,
  IconTags,
  IconTool,
  IconUsersGroup,
} from '@tabler/icons-react';

/**
 * Main navigation. `permission` hides an item from users without it. On phones, `phone` places
 * it in the bottom bar ('bar'; only the first four permitted ones fit, the rest go under More), as the raised centre button ('primary') or under More ('more').
 */
export const navItems = [
  { label: 'Home', path: '/', icon: IconHome2, phone: 'bar' },
  { label: 'Orders', path: '/orders', permission: 'orders.read.own', icon: IconNeedleThread, phone: 'bar' },
  { label: 'Bills', path: '/bills', permission: 'money.view', icon: IconReceipt2, phone: 'bar' },
  { label: 'Customers', path: '/customers', permission: 'customers.read', icon: IconAddressBook, phone: 'bar' },
  { label: 'Production', path: '/production', permission: 'orders.read.own', icon: IconLayoutKanban, phone: 'bar' },
  { label: 'New order', path: '/orders/new', permission: 'orders.write', icon: IconPlus, phone: 'primary' },
  { label: 'Price list', path: '/catalog', permission: 'catalog.manage', icon: IconTags, phone: 'more' },
  { label: 'Accounts', path: '/accounts', permission: 'periods.lock', icon: IconBuildingBank, phone: 'more' },
  { label: 'Workshop', path: '/workshop', permission: 'workshop.manage', icon: IconTool, phone: 'more' },
  { label: 'Users', path: '/users', permission: 'users.manage', icon: IconUsersGroup, phone: 'more' },
  { label: 'Settings', path: '/settings', permission: 'settings.edit', icon: IconAdjustmentsHorizontal, phone: 'more' },
];

/** The item the current page belongs to: the longest path that the location starts with. */
export function activePath(items, pathname) {
  const matches = items.filter((i) => i.path === pathname || (i.path !== '/' && pathname.startsWith(`${i.path}/`)));
  return matches.sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null;
}
