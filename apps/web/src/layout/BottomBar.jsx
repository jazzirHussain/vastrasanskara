import { Link } from 'react-router-dom';
import { Drawer, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconDots, IconLogout } from '@tabler/icons-react';

const MAX_BAR = 4;

/**
 * Phone navigation: the main pages in a bar along the bottom, New order raised in the centre,
 * and everything else (with Log out) under More.
 */
export function BottomBar({ items, active, user, onLogout }) {
  const [moreOpen, more] = useDisclosure(false);
  // Five slots fit 390 px beside More: the first four permitted bar items; the others go under More.
  const barItems = items.filter((i) => i.phone === 'bar');
  const bar = barItems.slice(0, MAX_BAR);
  const primary = items.find((i) => i.phone === 'primary');
  const rest = [...barItems.slice(MAX_BAR), ...items.filter((i) => i.phone === 'more')];
  // The raised button sits in the middle of the bar.
  const slots = primary ? [...bar.slice(0, 2), primary, ...bar.slice(2)] : bar;

  return (
    <>
      <nav aria-label="Main" className="vs-bottom-bar">
        {slots.map(({ path, label, icon: Icon, phone }) => (
          <Link
            key={path}
            to={path}
            className={`vs-bottom-link${phone === 'primary' ? ' vs-bottom-primary' : ''}`}
            aria-current={active === path ? 'page' : undefined}
          >
            {phone === 'primary' ? (
              <span className="vs-bottom-disc">
                <Icon size={26} stroke={2} aria-hidden="true" />
              </span>
            ) : (
              <Icon size={22} stroke={1.6} aria-hidden="true" />
            )}
            {label}
          </Link>
        ))}
        <button type="button" className="vs-bottom-link" onClick={more.open} aria-haspopup="dialog">
          <IconDots size={22} stroke={1.6} aria-hidden="true" />
          More
        </button>
      </nav>
      <Drawer opened={moreOpen} onClose={more.close} position="bottom" size="auto" title={user.name} radius="md">
        <Stack gap={2} pb="md">
          {rest.map(({ path, label, icon: Icon }) => (
            <UnstyledButton key={path} component={Link} to={path} onClick={more.close} py="sm">
              <Text fw={500} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Icon size={20} stroke={1.6} aria-hidden="true" />
                {label}
              </Text>
            </UnstyledButton>
          ))}
          <UnstyledButton onClick={onLogout} py="sm">
            <Text fw={500} c="var(--vs-kumkum)" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <IconLogout size={20} stroke={1.6} aria-hidden="true" />
              Log out
            </Text>
          </UnstyledButton>
        </Stack>
      </Drawer>
    </>
  );
}
