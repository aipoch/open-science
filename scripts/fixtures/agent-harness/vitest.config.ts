import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['acceptance/*.test.ts'], testTimeout: 15000 }
})
