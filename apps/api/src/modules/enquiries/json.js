// Enquiry response shapes. Budgets appear here only (never in appointment responses).

const person = (id, names) => (id ? { id: String(id), name: names?.get(String(id)) ?? null } : null);

/** Ids of the users named in an enquiry's log (for getUserNames). */
export const enquiryUserIds = (e) => (e.log ?? []).map((entry) => entry.by).filter(Boolean);

/**
 * The enquiry page. `names` maps user ids to names; `customer` ({ _id, name, phone }) and `order`
 * ({ _id, orderNo }) fill in the conversion when known.
 */
export function toEnquiryJson(e, { names, customer = null, order = null } = {}) {
  return {
    id: String(e._id),
    name: e.name,
    phone: e.phone,
    garmentTypes: e.garmentTypes ?? [],
    interest: e.interest ?? '',
    budget: e.budget ?? null,
    source: e.source,
    occasionDate: e.occasionDate ?? null,
    followUpDate: e.followUpDate ?? null,
    status: e.status,
    isOpen: e.isOpen,
    lostReason: e.lostReason ?? null,
    enquiryDate: e.enquiryDate,
    convertedCustomer: e.convertedCustomerId
      ? { id: String(e.convertedCustomerId), ...(customer ? { name: customer.name, phone: customer.phone } : {}) }
      : null,
    convertedOrder: e.convertedOrderId
      ? { id: String(e.convertedOrderId), ...(order ? { orderNo: order.orderNo } : {}) }
      : null,
    log: (e.log ?? []).map((entry) => ({ at: entry.at, by: person(entry.by, names), kind: entry.kind, text: entry.text })),
    createdAt: e.createdAt,
    version: e.__v,
  };
}

/** A list row; `today` marks overdue call-backs. */
export function toEnquiryRowJson(e, { today }) {
  return {
    id: String(e._id),
    name: e.name,
    phone: e.phone,
    garmentTypes: e.garmentTypes ?? [],
    interest: e.interest ?? '',
    source: e.source,
    followUpDate: e.followUpDate ?? null,
    status: e.status,
    enquiryDate: e.enquiryDate,
    overdue: Boolean(e.isOpen && e.followUpDate && e.followUpDate < today),
  };
}
