import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage.jsx';
import { LoginPage } from './auth/LoginPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { RequirePermission } from './auth/RequirePermission.jsx';
import { ResetPasswordPage } from './auth/ResetPasswordPage.jsx';
import { HomePage } from './features/home/HomePage.jsx';
import { SettingsPage } from './features/settings/SettingsPage.jsx';
import { UsersPage } from './features/users/UsersPage.jsx';
import { AppLayout } from './layout/AppLayout.jsx';

/** Routes. Rendered inside a router (BrowserRouter in main.jsx, MemoryRouter in tests). */
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />
            <Route element={<RequirePermission permission="users.manage" />}>
              <Route path="/users" element={<UsersPage />} />
            </Route>
            <Route element={<RequirePermission permission="settings.edit" />}>
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
