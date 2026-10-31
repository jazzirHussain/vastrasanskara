import { ReasonDialog } from '../../components/ReasonDialog.jsx';
import { useVoidExpense } from './expensesApi.js';

/** "Void expense": a reason is required; the expense stays listed, marked void. */
export function VoidExpenseDialog({ expense, onClose }) {
  const voidIt = useVoidExpense(expense.id);
  return (
    <ReasonDialog
      title="Void this expense?"
      reasonLabel="Why is it being voided?"
      confirmLabel="Yes, void it"
      pending={voidIt.isPending}
      error={voidIt.error ? voidIt.error.message : null}
      onClose={onClose}
      onConfirm={(reason) => voidIt.mutate({ reason, version: expense.version }, { onSuccess: onClose })}
    >
      The expense stays in the list, marked void, and stops counting. This cannot be undone.
    </ReasonDialog>
  );
}
