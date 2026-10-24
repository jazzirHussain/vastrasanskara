import { formatINR } from '@vs/shared/money.js';

/** An amount in paise as rupees. Renders nothing when absent (the server strips money fields). */
export function Money({ paise, ...props }) {
  if (paise === undefined || paise === null) return null;
  return (
    <span className="vs-figures" {...props}>
      {formatINR(paise)}
    </span>
  );
}
