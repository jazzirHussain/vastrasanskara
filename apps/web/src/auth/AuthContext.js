import { createContext, useContext } from 'react';

export const AuthContext = createContext(null);

/** { user, loading, error, can(permission), login(email, password), logout() } */
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
}
