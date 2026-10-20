import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { name: 'test-impact', include: ['src/**/*.test.ts'], testTimeout: 30000 }
})
