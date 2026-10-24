import { defineProject } from 'vitest/config';

export default defineProject({
  // React 17+ JSX transform: components don't need `import React`.
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['src/test/setup.js'],
  },
});
