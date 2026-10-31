import { rupeesToPaise } from '@vs/shared/money.js';

/** Paise as the plain rupee text of an input ("2000", "2000.5"); empty for nothing. */
export function rupeeText(paise) {
  if (!paise || paise <= 0) return '';
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest ? `${rupees}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(rupees);
}

/** The amount typed, in paise; null when empty or not above zero. */
export function paiseOf(value) {
  if (value === '' || value === null || value === undefined) return null;
  try {
    const paise = rupeesToPaise(value);
    return paise > 0 ? paise : null;
  } catch {
    return null;
  }
}
