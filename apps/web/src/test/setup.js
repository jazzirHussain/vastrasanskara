import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import App from '../App.jsx';
import { createQueryClient } from '../lib/queryClient.js';
import { ROUTER_FUTURE } from '../lib/router.js';
import { theme } from '../theme.js';
import { server } from './server.js';

// jsdom lacks these browser APIs that Mantine uses.
window.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

/** Renders the whole app at `path` with a fresh query cache, as main.jsx does with BrowserRouter. */
export function renderApp(path = '/') {
  const queryClient = createQueryClient();
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MantineProvider,
        { theme },
        createElement(MemoryRouter, { initialEntries: [path], future: ROUTER_FUTURE }, createElement(App)),
      ),
    ),
  );
}
