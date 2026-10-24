import { useNavigate } from 'react-router-dom';
import { ActionIcon, Indicator, Menu, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api.js';

const NOTIFICATIONS_KEY = ['notifications'];
const POLL_MS = 60_000;

function unreadLabel(count) {
  if (count === 0) return 'No unread notifications';
  return `${count} unread notification${count === 1 ? '' : 's'}`;
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

/**
 * The bell: polls every minute, opening an item marks it read. `tone="light"` for the indigo
 * sidebar.
 */
export function NotificationBell({ tone = 'dark' }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => apiFetch('/v1/notifications'),
    refetchInterval: POLL_MS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  const markRead = useMutation({
    mutationFn: (id) => apiFetch(`/v1/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const markAllRead = useMutation({
    mutationFn: () => apiFetch('/v1/notifications/read-all', { method: 'POST' }),
    onSuccess: refresh,
  });

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  function open(item) {
    if (!item.read) markRead.mutate(item.id);
    if (item.link) navigate(item.link);
  }

  return (
    <Menu position="bottom-end" width={320} shadow="md">
      <Menu.Target>
        <Indicator label={unread} size={16} disabled={unread === 0} offset={4} color="kumkum">
          <ActionIcon
            variant="subtle"
            size="lg"
            color={tone === 'light' ? 'gray.0' : 'indigo'}
            aria-label={unreadLabel(unread)}
          >
            <BellIcon />
          </ActionIcon>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        {items.length === 0 && (
          <Text size="sm" c="dimmed" p="sm">
            No notifications yet
          </Text>
        )}
        {items.map((item) => (
          <Menu.Item key={item.id} onClick={() => open(item)} fw={item.read ? 400 : 600}>
            {item.message}
          </Menu.Item>
        ))}
        {unread > 0 && (
          <>
            <Menu.Divider />
            <Menu.Item onClick={() => markAllRead.mutate()}>Mark all as read</Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
