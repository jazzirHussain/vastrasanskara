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
