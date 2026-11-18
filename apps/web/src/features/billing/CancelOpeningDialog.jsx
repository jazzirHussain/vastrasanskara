import { correctionErrorMessage } from '../../lib/errorMessages.js';
import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { useCancelOpeningBalance } from './billingApi.js';

/**
 * Cancels a customer's opening balance and opening advance (owner only), so the right figures
 * can be brought in again. `entry` is the ledger row { id, version }.
 */
export function CancelOpeningDialog({ entry, onClose }) {
  const cancel = useCancelOpeningBalance();
  return (
    <ReasonDialog
      title="Cancel the opening balance?"
      reasonLabel="Why is it being cancelled?"
      confirmLabel="Yes, cancel the opening balance"
      keepLabel="Keep it"
      pending={cancel.isPending}
      error={cancel.error ? correctionErrorMessage('opening', cancel.error) : null}
      onClose={onClose}
      onConfirm={(reason) => cancel.mutate({ id: entry.id, version: entry.version, reason }, { onSuccess: onClose })}
    >
      The amount owed and the advance held from your old records are both cancelled. Bring them in again from “Bring in old
      records” with the right figures.
    </ReasonDialog>
  );
}
