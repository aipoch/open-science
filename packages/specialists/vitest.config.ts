import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 15000, maxWorkers: 2 }
})
