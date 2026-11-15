import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage.jsx';
import { LoginPage } from './auth/LoginPage.jsx';
import { RequireAuth } from './auth/RequireAuth.jsx';
import { RequirePermission } from './auth/RequirePermission.jsx';
import { ResetPasswordPage } from './auth/ResetPasswordPage.jsx';
import { BillPage } from './features/billing/BillPage.jsx';
import { BillsPage } from './features/billing/BillsPage.jsx';
import { AccountsPage } from './features/accounts/AccountsPage.jsx';
import { CatalogPage } from './features/catalog/CatalogPage.jsx';
import { ExpensePage } from './features/expenses/ExpensePage.jsx';
import { ExpensesPage } from './features/expenses/ExpensesPage.jsx';
import { ExpenseFormPage } from './features/expenses/ExpenseFormPage.jsx';
import { StockPage } from './features/stock/StockPage.jsx';
import { StockItemPage } from './features/stock/StockItemPage.jsx';
import { CustomerPage } from './features/customers/CustomerPage.jsx';
import { CustomersPage } from './features/customers/CustomersPage.jsx';
import { EnquiriesPage } from './features/enquiries/EnquiriesPage.jsx';
import { EnquiryPage } from './features/enquiries/EnquiryPage.jsx';
import { NewEnquiryPage } from './features/enquiries/NewEnquiryPage.jsx';
import { AppointmentsPage } from './features/appointments/AppointmentsPage.jsx';
import { BookAppointmentPage } from './features/appointments/BookAppointmentPage.jsx';
import { HomePage } from './features/home/HomePage.jsx';
import { MetricPage } from './features/dashboard/MetricPage.jsx';
import { ReportsPage } from './features/reports/ReportsPage.jsx';
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
            <Route path="/home/:metric" element={<MetricPage />} />
            <Route element={<RequirePermission permission="reports.export" />}>
              <Route path="/reports" element={<ReportsPage />} />
            </Route>
            <Route element={<RequirePermission permission="customers.read" />}>
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/:id" element={<CustomerPage />} />
            </Route>
            <Route element={<RequirePermission permission="enquiries.write" />}>
              <Route path="/enquiries" element={<EnquiriesPage />} />
              <Route path="/enquiries/new" element={<NewEnquiryPage />} />
              <Route path="/enquiries/:id" element={<EnquiryPage />} />
            </Route>
            <Route element={<RequirePermission permission="appointments.own" />}>
              <Route path="/appointments" element={<AppointmentsPage />} />
            </Route>
            <Route element={<RequirePermission permission="appointments.write" />}>
              <Route path="/appointments/new" element={<BookAppointmentPage />} />
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
              <Route path="/bills" element={<BillsPage />} />
              <Route path="/bills/:id" element={<BillPage />} />
            </Route>
            <Route element={<RequirePermission permission="expenses.view" />}>
              <Route path="/expenses" element={<ExpensesPage />} />
              <Route path="/expenses/:id" element={<ExpensePage />} />
            </Route>
            <Route element={<RequirePermission permission="expenses.write" />}>
              <Route path="/expenses/new" element={<ExpenseFormPage />} />
              <Route path="/expenses/:id/edit" element={<ExpenseFormPage />} />
            </Route>
            <Route element={<RequirePermission permission="stock.view" />}>
              <Route path="/stock" element={<StockPage />} />
              <Route path="/stock/items/:id" element={<StockItemPage />} />
            </Route>
            <Route element={<RequirePermission permission="workshop.manage" />}>
              <Route path="/workshop" element={<WorkshopPage />} />
            </Route>
            <Route element={<RequirePermission permission="periods.lock" />}>
              <Route path="/accounts" element={<AccountsPage />} />
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
