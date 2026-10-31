/** "October 2026" for '2026-10'. */
export function monthLabel(month) {
  const [year, mm] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mm - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "30 November 2026" for '2026-11-30'. */
export const longDate = (ymd) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
