import { defineConfig } from 'vitest/config';

const setupFiles = ['test/setup-network-guard.ts'];
const exclude = ['**/node_modules/**', '**/*.db.test.ts', '**/*.golden.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          sequence: { groupOrder: 0 },
          include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude,
          setupFiles,
        },
      },
      {
        test: {
          name: 'db',
          sequence: { groupOrder: 1 },
          include: ['**/*.db.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['test/global-setup-db.ts'],
          setupFiles,
          maxWorkers: 1,
          isolate: false,
        },
      },
      {
        test: {
          name: 'golden',
          sequence: { groupOrder: 2 },
          include: ['**/*.golden.test.ts'],
          exclude: ['**/node_modules/**'],
          setupFiles,
          passWithNoTests: true,
        },
      },
    ],
  },
});
