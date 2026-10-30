import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage.jsx';
import { LoginPage } from './auth/LoginPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { RequirePermission } from './auth/RequirePermission.jsx';
import { ResetPasswordPage } from './auth/ResetPasswordPage.jsx';
import { BillPage } from './features/billing/BillPage.jsx';
import { CatalogPage } from './features/catalog/CatalogPage.jsx';
import { CustomerPage } from './features/customers/CustomerPage.jsx';
import { CustomersPage } from './features/customers/CustomersPage.jsx';
import { HomePage } from './features/home/HomePage.jsx';
import { NewOrderPage } from './features/orders/NewOrderPage.jsx';
import { OrderPage } from './features/orders/OrderPage.jsx';
import { OrdersPage } from './features/orders/OrdersPage.jsx';
import { ProductionPage } from './features/production/ProductionPage.jsx';
import { SettingsPage } from './features/settings/SettingsPage.jsx';
import { UsersPage } from './features/users/UsersPage.jsx';
import { WorkshopPage } from './features/workshop/WorkshopPage.jsx';
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
            <Route element={<RequirePermission permission="customers.read" />}>
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/:id" element={<CustomerPage />} />
            </Route>
            <Route element={<RequirePermission permission="orders.read.own" />}>
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/orders/:id" element={<OrderPage />} />
              <Route path="/production" element={<ProductionPage />} />
            </Route>
            <Route element={<RequirePermission permission="orders.write" />}>
              <Route path="/orders/new" element={<NewOrderPage />} />
            </Route>
            <Route element={<RequirePermission permission="money.view" />}>
              <Route path="/bills/:id" element={<BillPage />} />
            </Route>
            <Route element={<RequirePermission permission="workshop.manage" />}>
              <Route path="/workshop" element={<WorkshopPage />} />
            </Route>
            <Route element={<RequirePermission permission="catalog.manage" />}>
              <Route path="/catalog" element={<CatalogPage />} />
            </Route>
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
