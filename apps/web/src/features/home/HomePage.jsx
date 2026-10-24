import { Title } from '@mantine/core';
import { useAuth } from '../../auth/AuthContext.js';

// Placeholder until the dashboard milestone.
export function HomePage() {
  const { user } = useAuth();
  return <Title order={2}>Welcome, {user.name}</Title>;
}
