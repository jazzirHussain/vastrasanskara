import { StatusBadge } from '../../components/StatusBadge.jsx';

const LABELS = {
  new: ['New', 'active'],
  contacted: ['Contacted', 'in_progress'],
  appointment_booked: ['Appointment booked', 'tight'],
  converted: ['Converted', 'completed'],
  lost: ['Not interested', 'cancelled'],
};

/** An enquiry's status in plain words, coloured like the order statuses. */
export function EnquiryStatus({ status }) {
  const [label, tone] = LABELS[status] ?? [status, status];
  return <StatusBadge status={tone} label={label} />;
}
