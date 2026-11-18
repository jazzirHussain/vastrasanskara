// Drill-down row builders. Each row is built from named fields, never by spreading a record:
// { id, title, subtitle, amount?, date?, badge?, link }.
import { displayDate } from '@vs/shared/fy.js';
import { STAGES } from '@vs/shared/stages.js';

export const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? key;

/** Drops keys whose value is undefined (rows stay small and predictable). */
export const compact = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

/** A row for an open garment item of listProductionGarments. */
export function garmentRow({ garment, order, customerName, workingStage }) {
  const due = garment.dueDate ?? order.pickupDate;
  return {
    id: String(garment._id),
    title: `${garment.garmentNo} · ${garment.description}`,
    subtitle: `${order.orderNo} · ${customerName ?? ''} · due ${displayDate(due)}`,
    date: due,
    badge: stageLabel(workingStage),
    link: `/orders/${order._id}`,
  };
}

/** A row for a listOrders item { order, customerName, designerName }. */
export function orderRow({ order, customerName, designerName }) {
  return compact({
    id: String(order._id),
    title: order.orderNo,
    subtitle: [customerName, designerName].filter(Boolean).join(' · '),
    date: order.pickupDate,
    badge: order.priority === 'rush' ? 'Rush' : undefined,
    link: `/orders/${order._id}`,
  });
}
