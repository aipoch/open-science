import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'research-film',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000
  }
})
