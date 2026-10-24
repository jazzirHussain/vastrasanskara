import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Alert, Button, Center, Loader, Stack } from '@mantine/core';
import { useAuth } from './AuthContext.js';

/** Renders the child routes for a signed-in user; otherwise sends them to /login. */
export function RequireAuth() {
  const { user, loading, error, retry } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (error) {
    return (
      <Center h="100vh" p="md">
        <Stack align="center">
          <Alert color="red" title="Cannot load your account">
            {error.message}
          </Alert>
          <Button onClick={() => retry()}>Try again</Button>
        </Stack>
      </Center>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}
