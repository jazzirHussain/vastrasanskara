// The quick enquiry form, as plain functions (tested on their own).
import { addDaysYmd } from '@vs/shared/fy.js';
import { paiseOf } from '../billing/rupees.js';
import { SOURCES } from '../customers/CustomerForm.jsx';

/** A fresh form: call back tomorrow, heard of us by walking in. */
export function emptyEnquiryForm(today) {
  return {
    phone: '',
    name: '',
    garmentTypes: [],
    interest: '',
    budget: '',
    source: 'walk_in',
    occasionDate: '',
    followUpDate: addDaysYmd(today, 1),
    note: '',
  };
}

/** The call-back chips. */
export function followUpChoices(today) {
  return [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: addDaysYmd(today, 1) },
    { label: 'In 3 days', date: addDaysYmd(today, 3) },
    { label: 'Next week', date: addDaysYmd(today, 7) },
  ];
}

/** The POST /v1/enquiries body: rupees → paise, empty budget and dates → null. */
export function formToEnquiryBody(form) {
  return {
    name: form.name.trim(),
    phone: form.phone.trim(),
    garmentTypes: form.garmentTypes,
    interest: form.interest.trim(),
    budget: paiseOf(String(form.budget).replace(/,/g, '').trim()),
    source: form.source,
    occasionDate: form.occasionDate || null,
    followUpDate: form.followUpDate || null,
    note: form.note.trim(),
  };
}

/** 'film_industry' → 'Film industry'. */
export const sourceLabel = (key) => SOURCES.find((s) => s.value === key)?.label ?? key;
