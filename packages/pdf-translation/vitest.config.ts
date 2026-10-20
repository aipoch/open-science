import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'pdf-translation',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2
  }
})
