import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works from any path (root domain or sub-folder).
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'] },
});
