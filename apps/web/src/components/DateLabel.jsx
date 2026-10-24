import { istDate } from '@vs/shared/fy.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

const parse = (ymd) => new Date(`${ymd}T00:00:00Z`);

/** Today's business date in India. */
export const todayYmd = () => istDate(new Date());

/** Whole days from today (IST) to `ymd`; negative in the past. */
export const daysFromToday = (ymd) => Math.round((parse(ymd) - parse(todayYmd())) / DAY_MS);

/** 'Fri 14 Nov', with the year when it is not this year. */
export function shortDate(ymd) {
  const d = parse(ymd);
  const year = d.getUTCFullYear() === parse(todayYmd()).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

function relative(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return `${-days} day${days === -1 ? '' : 's'} late`;
}

/**
 * A due or pickup date: 'Fri 14 Nov' and how far away it is ('today', 'in 3 days',
 * '2 days late'). Past dates read as late, so use `relative={false}` for dates that are not
 * deadlines.
 */
export function DateLabel({ ymd, relative: showRelative = true, done = false }) {
  if (!ymd) return null;
  const days = daysFromToday(ymd);
  const tone = done ? 'var(--vs-muted)' : days < 0 ? 'var(--vs-kumkum)' : days <= 1 ? 'var(--vs-haldi)' : 'var(--vs-muted)';
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span className="vs-figures">{shortDate(ymd)}</span>
      {showRelative && !done && (
        <span style={{ marginLeft: 6, fontSize: 13, color: tone, fontWeight: days < 0 ? 600 : 500 }}>
          {relative(days)}
        </span>
      )}
    </span>
  );
}
