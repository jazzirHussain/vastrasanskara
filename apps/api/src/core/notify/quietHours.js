import { addDaysYmd, atIstTime, istDate } from '@vs/shared/fy.js';

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * When a message may be sent given an IST quiet-hours window ({ start, end } as 'HH:mm',
 * end exclusive). Returns `now` outside the window (or with no window), otherwise the
 * window's next end. Windows may cross midnight; start === end means no quiet hours.
 */
export function nextAllowedTime(now, window) {
  if (!window || window.start === window.end) return now;

  const today = istDate(now);
  const sinceMidnight = now.getTime() - atIstTime(today, '00:00').getTime();
  const start = minutesOf(window.start) * 60_000;
  const end = minutesOf(window.end) * 60_000;

  if (start < end) {
    return sinceMidnight >= start && sinceMidnight < end ? atIstTime(today, window.end) : now;
  }
  // Crosses midnight: quiet from start until midnight, and from midnight until end.
  if (sinceMidnight >= start) return atIstTime(addDaysYmd(today, 1), window.end);
  if (sinceMidnight < end) return atIstTime(today, window.end);
  return now;
}
