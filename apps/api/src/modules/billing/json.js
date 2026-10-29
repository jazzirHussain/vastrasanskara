/** An invoice view (from invoiceView) as the API answers. */
export function toInvoiceJson(view) {
  const { invoice } = view;
  const pdfStatus = invoice.pdf?.status;
  return {
    id: String(invoice._id),
    type: 'invoice',
    status: invoice.status,
    number: invoice.number ?? null,
    date: invoice.date ?? null,
    dueDate: invoice.dueDate ?? null,
    customer: view.customer,
    order: view.order,
    lines: view.lines,
    invoiceDiscount: view.invoiceDiscount,
    notes: view.notes,
    placeOfSupply: view.placeOfSupply,
    totals: view.totals,
    amountInWords: view.amountInWords,
    settlement: view.settlement,
    overdue: view.overdue,
    monthLocked: view.monthLocked,
    remindersPaused: Boolean(invoice.remindersPaused),
    advanceAdjustments: (invoice.advanceAdjustments ?? []).map((a) => ({
      receiptVoucherId: String(a.receiptVoucherId),
      number: a.number,
      taxable: a.taxable,
      tax: a.cgst + a.sgst + a.igst,
    })),
    creditNotes: view.creditNotes,
    warnings: view.warnings,
    pdf: pdfStatus && pdfStatus !== 'none' ? { status: pdfStatus } : null,
    cancellation: invoice.cancellation ? { reason: invoice.cancellation.reason, at: invoice.cancellation.at } : null,
    version: invoice.__v,
  };
}

const pdfOf = (doc) => (doc.pdf?.status && doc.pdf.status !== 'none' ? { status: doc.pdf.status } : null);
const cancellationOf = (doc) => (doc.cancellation ? { reason: doc.cancellation.reason, at: doc.cancellation.at } : null);

/** A receipt view (from receiptView) as the API answers. */
export function toReceiptJson(view) {
  const { receipt, receiptVoucher: rv } = view;
  return {
    id: String(receipt._id),
    type: 'receipt',
    status: receipt.status,
    number: receipt.number,
    date: receipt.date,
    amount: receipt.amount,
    mode: receipt.mode,
    reference: receipt.reference ?? '',
    receivedOn: receipt.receivedOn ?? null,
    note: receipt.note ?? '',
    customer: view.customer,
    order: view.order,
    allocations: view.allocations,
    unallocated: view.unallocated,
    receiptVoucher: rv
      ? { id: String(rv._id), number: rv.number, taxable: rv.taxable, cgst: rv.cgst, sgst: rv.sgst, igst: rv.igst }
      : null,
    pdf: pdfOf(receipt),
    cancellation: cancellationOf(receipt),
  };
}

/** A stored receipt voucher as the API answers. */
export function toReceiptVoucherJson(rv) {
  return {
    id: String(rv._id),
    type: 'receipt_voucher',
    status: rv.status,
    number: rv.number,
    date: rv.date,
    receiptId: String(rv.receiptId),
    gross: rv.gross,
    taxable: rv.taxable,
    cgst: rv.cgst,
    sgst: rv.sgst,
    igst: rv.igst,
    lines: rv.snapshot?.lines ?? [],
    pdf: pdfOf(rv),
    cancellation: cancellationOf(rv),
  };
}
