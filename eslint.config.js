import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'data/**', 'fixtures/**', 'runs/**', '.planning/**', '**/migrations/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    rules: {
      // Node's global fetch bundles undici 6 and breaks with an undici 8 dispatcher (Pitfall 4).
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'use the @pp/core fetcher (undici 8)' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: 'use the @pp/core fetcher (undici 8)' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: 'use the @pp/core fetcher' },
            { name: 'node:https', message: 'use the @pp/core fetcher' },
            { name: 'http', message: 'use the @pp/core fetcher' },
            { name: 'https', message: 'use the @pp/core fetcher' },
            { name: 'axios', message: 'use the @pp/core fetcher' },
            { name: 'node-fetch', message: 'use the @pp/core fetcher' },
            { name: 'got', message: 'use the @pp/core fetcher' },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The network guard and its test deliberately replace / call global fetch.
    files: ['test/setup-network-guard.ts', 'packages/core/test/guard.test.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
);
