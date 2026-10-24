import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.data/**', '.dev-files/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['apps/web/src/**/*.{js,jsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
];
