import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { useUndoReceipt } from './stockApi.js';

/** "Undo delivery": the stock comes back out and the expense is voided, with the reason. */
export function UndoReceiptDialog({ request, onClose }) {
  const undo = useUndoReceipt(request.id);
  return (
    <ReasonDialog
      title="Undo delivery"
      reasonLabel="Why undo it?"
      confirmLabel="Yes, undo delivery"
      pending={undo.isPending}
      error={undo.error?.message}
      onClose={onClose}
      onConfirm={async (reason) => {
        try {
          await undo.mutateAsync({ version: request.version, reason });
          onClose();
        } catch {
          // Shown in the dialog (a delivery already used says so).
        }
      }}
    >
      The stock comes back out and the expense is voided.
    </ReasonDialog>
  );
}
