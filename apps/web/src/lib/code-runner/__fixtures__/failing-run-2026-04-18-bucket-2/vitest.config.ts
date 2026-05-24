// Bucket 2 — vitest config with the `defineConfig() {` LLM shape that
// previously was only repaired in vite.config.*. The doctor must now
// rewrite this too.
import { defineConfig } from 'vitest/config';

export default defineConfig() {
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
}
