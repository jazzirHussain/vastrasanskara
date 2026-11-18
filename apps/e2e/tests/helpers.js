import { expect } from '@playwright/test';
import { PASSWORD, USERS } from '../seed.js';

/** Signs in through the login page as 'admin', 'operations' or 'designer' and waits for Home. */
export async function login(page, who) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS[who].email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`^Welcome, ${USERS[who].name}`) })).toBeVisible();
}

/** A new browser context (its own session cookie) signed in as `who`. */
export async function signedIn(browser, who) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, who);
  return page;
}

let phones = 0;
/** A fresh 10-digit mobile number for each customer a journey adds. */
export const nextPhone = () => `98450${String(Date.now() % 100000 + phones++).padStart(5, '0').slice(-5)}`;

/** 'YYYY-MM-DD' `days` from today in IST. */
export function istDay(days = 0) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Ticks a radio or checkbox by clicking its label: Mantine chips hide the input itself, so
 * Playwright's check() would wait for it to become visible.
 */
export async function pick(input) {
  const id = await input.getAttribute('id');
  await input.page().locator(`label[for="${id}"]`).click();
  await expect(input).toBeChecked();
}
