import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { LoginPage } from './auth/LoginPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { HomePage } from './features/home/HomePage.jsx';
import { AppLayout } from './layout/AppLayout.jsx';

/** Routes. Rendered inside a router (BrowserRouter in main.jsx, MemoryRouter in tests). */
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
