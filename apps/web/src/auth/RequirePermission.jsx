import { Outlet } from 'react-router-dom';
import { Alert } from '@mantine/core';
import { errorMessages } from '../lib/errorMessages.js';
import { useAuth } from './AuthContext.js';

/** Renders the child routes only for users holding `permission` (the server enforces it too). */
export function RequirePermission({ permission }) {
  const { can } = useAuth();
  if (!can(permission)) return <Alert color="yellow">{errorMessages.FORBIDDEN}</Alert>;
  return <Outlet />;
}
