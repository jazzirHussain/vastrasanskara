import { DashboardPage } from '../dashboard/DashboardPage.jsx';
import { GoLiveBanner } from '../goLive/GoLiveBanner.jsx';

/** Home is the dashboard (M8): what needs attention, key numbers and the business tiles. */
export function HomePage() {
  return (
    <>
      <GoLiveBanner />
      <DashboardPage />
    </>
  );
}
