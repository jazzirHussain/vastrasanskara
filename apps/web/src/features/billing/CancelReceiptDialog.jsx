import { correctionErrorMessage } from '../../lib/errorMessages.js';
import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { useCancelReceipt } from './billingApi.js';

/** Cancels a payment (owner only): the money comes off any bills it paid. `receipt` is { id, number }. */
export function CancelReceiptDialog({ receipt, onClose }) {
  const cancel = useCancelReceipt();
  return (
    <ReasonDialog
      title={`Cancel payment ${receipt.number}?`}
      reasonLabel="Why is it being cancelled?"
      confirmLabel="Yes, cancel the payment"
      keepLabel="Keep payment"
      pending={cancel.isPending}
      error={cancel.error ? correctionErrorMessage('receipt', cancel.error) : null}
      onClose={onClose}
      onConfirm={(reason) => cancel.mutate({ id: receipt.id, reason }, { onSuccess: onClose })}
    >
      The money comes off any bills it paid. The receipt number stays, marked cancelled.
    </ReasonDialog>
  );
}
