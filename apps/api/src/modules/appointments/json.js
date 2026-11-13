// Appointment response shape. Never carries a budget or any money.
import { istTime } from '@vs/shared';

const named = (id, names) => (id ? { id: String(id), name: names.get(String(id)) ?? null } : null);

/** The client of an appointment: its customer, or the customer its enquiry was converted to. */
export const clientIdOf = (a, enquiries) =>
  a.customerId ?? (a.enquiryId ? (enquiries.get(String(a.enquiryId))?.convertedCustomerId ?? null) : null);

/**
 * `ctx`: `names` (user id → name), `customers` (id → { name, phone }), `enquiries` (id → { name,
 * phone, convertedCustomerId }), `garments` (id → { garmentNo, description }). An enquiry's phone
 * is shown only with `showEnquiryPhone` (front desk); designers never see it.
 */
export function toAppointmentJson(a, { names, customers, enquiries, garments, showEnquiryPhone = false }) {
  const clientId = clientIdOf(a, enquiries);
  const customer = clientId ? customers.get(String(clientId)) : null;
  const enquiry = a.enquiryId ? enquiries.get(String(a.enquiryId)) : null;
  return {
    id: String(a._id),
    type: a.type,
    date: a.date,
    time: istTime(a.start),
    minutes: a.minutes,
    start: a.start,
    end: a.end,
    status: a.status,
    designer: named(a.designerId, names),
    customer: clientId ? { id: String(clientId), name: customer?.name ?? null, phone: customer?.phone ?? null } : null,
    enquiry: a.enquiryId
      ? {
          id: String(a.enquiryId),
          name: enquiry?.name ?? null,
          ...(showEnquiryPhone ? { phone: enquiry?.phone ?? null } : {}),
        }
      : null,
    garments: (a.garmentIds ?? []).map((id) => {
      const g = garments.get(String(id));
      return { id: String(id), garmentNo: g?.garmentNo ?? null, description: g?.description ?? null };
    }),
    note: a.note ?? '',
    cancelReason: a.cancelReason ?? null,
    statusAt: a.statusAt ?? null,
    statusBy: named(a.statusBy, names),
    createdAt: a.createdAt,
    version: a.__v,
  };
}
