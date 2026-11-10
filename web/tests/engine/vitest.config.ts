import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Kept beside the tests: web/vite.config.ts boots the dev plugins and is not
// ours to change. One file at a time, because each file boots its own engine.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    hookTimeout: 180_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
