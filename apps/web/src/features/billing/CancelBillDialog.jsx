import { billErrorMessage } from '../../lib/errorMessages.js';
import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { useCancelInvoice } from './billingApi.js';

/** Cancels an issued bill (owner only): payments on it stay with the customer as advance. */
export function CancelBillDialog({ invoice, onClose }) {
  const cancel = useCancelInvoice(invoice.id);
  return (
    <ReasonDialog
      title={`Cancel bill ${invoice.number}?`}
      reasonLabel="Why is it being cancelled?"
      confirmLabel="Yes, cancel the bill"
      keepLabel="Keep bill"
      pending={cancel.isPending}
      error={cancel.error ? billErrorMessage(cancel.error) : null}
      onClose={onClose}
      onConfirm={(reason) => cancel.mutate({ reason }, { onSuccess: onClose })}
    >
      Payments on this bill will be kept as advance for {invoice.customer.name}. The bill number stays, marked cancelled.
    </ReasonDialog>
  );
}
