import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['test/**/*.test.ts'], maxWorkers: 4, testTimeout: 15000, hookTimeout: 30000 }
})
