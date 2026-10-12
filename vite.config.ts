import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works from any path (root domain or sub-folder).
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    // Real-data tests parse a 9 MB CSV and boot the app on 44 datasets in jsdom; shared CI runners can be slow.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
