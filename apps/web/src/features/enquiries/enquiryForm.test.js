import { expect, test } from 'vitest';
import { emptyEnquiryForm, followUpChoices, formToEnquiryBody, sourceLabel } from './enquiryForm.js';

test('call back defaults to tomorrow', () => {
  const form = emptyEnquiryForm('2026-12-01');
  expect(form).toMatchObject({ phone: '', name: '', followUpDate: '2026-12-02', source: 'walk_in', garmentTypes: [], budget: '' });
});

test('follow-up choices are today, tomorrow, in 3 days and next week', () => {
  expect(followUpChoices('2026-12-01')).toEqual([
    { label: 'Today', date: '2026-12-01' },
    { label: 'Tomorrow', date: '2026-12-02' },
    { label: 'In 3 days', date: '2026-12-04' },
    { label: 'Next week', date: '2026-12-08' },
  ]);
});

test('the budget is sent in paise and may be empty', () => {
  const form = { ...emptyEnquiryForm('2026-12-01'), phone: ' 98450 12345 ', name: ' Priya ', garmentTypes: ['lehenga'] };
  expect(formToEnquiryBody({ ...form, budget: '1,50,000' })).toEqual({
    name: 'Priya',
    phone: '98450 12345',
    garmentTypes: ['lehenga'],
    interest: '',
    budget: 15000000,
    source: 'walk_in',
    occasionDate: null,
    followUpDate: '2026-12-02',
    note: '',
  });
  expect(formToEnquiryBody({ ...form, budget: '' }).budget).toBeNull();
  expect(formToEnquiryBody({ ...form, budget: '2500.50' }).budget).toBe(250050);
  expect(formToEnquiryBody({ ...form, occasionDate: '2027-02-14' }).occasionDate).toBe('2027-02-14');
});

test('sources read in plain words', () => {
  expect(['instagram', 'referral', 'walk_in', 'website', 'film_industry', 'other'].map(sourceLabel)).toEqual([
    'Instagram',
    'Referral',
    'Walk-in',
    'Website',
    'Film industry',
    'Other',
  ]);
});
