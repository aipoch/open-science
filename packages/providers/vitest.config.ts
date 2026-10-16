import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'providers',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000
  }
})
