import { Text } from '@mantine/core';
import { formatINR } from '@vs/shared/money.js';
import { errorMessages } from '../../lib/errorMessages.js';

const percent = (bp) => `${bp / 100}%`;

function Row({ label, hint, value, strong, big }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: big ? '10px 0 6px' : '4px 0' }}>
      <div>
        <Text fw={strong || big ? 700 : 500} size={big ? 'lg' : 'sm'}>
          {label}
        </Text>
        {hint && (
          <Text size="xs" c="var(--vs-muted)">
            {hint}
          </Text>
        )}
      </div>
      <span className="vs-figures" style={{ fontWeight: strong || big ? 700 : 500, fontSize: big ? 26 : 15, whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}

const minus = (paise) => `−${formatINR(paise)}`;

/** "GST 5%" (or "GST 5% and 18%") and its parts in small print. */
function gstRow(totals, rates, interState) {
  const label = `GST ${[...new Set(rates)].sort((a, b) => a - b).map(percent).join(' and ') || '0%'}`;
  const parts = interState ? `IGST ${formatINR(totals.igst)}` : `CGST ${formatINR(totals.cgst)} · SGST ${formatINR(totals.sgst)}`;
  return <Row label={label} hint={parts} value={formatINR(totals.tax)} />;
}

/**
 * The bill's totals, readable at a glance: before GST, GST, round-off, the total in large type,
 * then what has been paid and what is left to pay.
 *
 * - `totals`, `rates` (basis points used) and `interState` from computeInvoice or the issued bill.
 * - `draft`: says GST is added; `advance` is the order's advance that issuing will use.
 * - `settlement` for an issued bill. `unavailable` ({ missing } or { code }) when a draft cannot be totalled yet.
 */
export function BillTotals({ totals, rates = [], interState = false, draft = false, advance = 0, settlement, amountInWords, unavailable }) {
  let body;
  if (unavailable) {
    body = (
      <Text c="var(--vs-muted)" size="sm">
        {unavailable.missing ? 'Choose what each line is billed as to see the total.' : (errorMessages[unavailable.code] ?? errorMessages.INVALID_AMOUNT)}
      </Text>
    );
  } else {
    const applied = Math.min(advance, totals.total);
    body = (
      <>
        {totals.discount > 0 && (
          <>
            <Row label="Price of items" value={formatINR(totals.gross)} />
            <Row label="Discount" value={minus(totals.discount)} />
          </>
        )}
        <Row label="Before GST" hint={draft ? 'GST will be added' : null} value={formatINR(totals.taxable)} />
        {gstRow(totals, rates, interState)}
        {totals.roundOff !== 0 && (
          <Row label="Round-off" value={totals.roundOff > 0 ? `+${formatINR(totals.roundOff)}` : minus(-totals.roundOff)} />
        )}
        <div style={{ borderTop: '1px solid var(--vs-rule)', marginTop: 6 }}>
          <Row label="Total" value={formatINR(totals.total)} big />
          {amountInWords && (
            <Text size="xs" c="var(--vs-muted)">
              {amountInWords}
            </Text>
          )}
        </div>
        {draft && applied > 0 && (
          <div style={{ borderTop: '1px solid var(--vs-rule)', marginTop: 8, paddingTop: 4 }}>
            <Row label="Advance already paid" value={minus(applied)} />
            <Row label="To pay" value={formatINR(totals.total - applied)} strong />
            {advance > applied && (
              <Text size="xs" c="var(--vs-muted)">
                {formatINR(advance - applied)} of the advance stays with the customer for later.
              </Text>
            )}
          </div>
        )}
        {settlement && (
          <div style={{ borderTop: '1px solid var(--vs-rule)', marginTop: 8, paddingTop: 4 }}>
            {settlement.advanceApplied > 0 && <Row label="Advance already paid" value={minus(settlement.advanceApplied)} />}
            {settlement.paid - settlement.advanceApplied > 0 && <Row label="Paid since" value={minus(settlement.paid - settlement.advanceApplied)} />}
            {settlement.credited > 0 && <Row label="Reduced by credit notes" value={minus(settlement.credited)} />}
            <Row label="Balance to pay" value={formatINR(settlement.balance)} strong />
          </div>
        )}
      </>
    );
  }
  return (
    <section aria-label="Bill totals" className="vs-panel" style={{ padding: '14px 18px' }}>
      {body}
    </section>
  );
}
