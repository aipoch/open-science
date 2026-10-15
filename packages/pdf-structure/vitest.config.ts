import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Dense vector stress cases must not compete with more workers than the runner's CPUs.
  // Match the host's CPU-minus-one scheduling while retaining the standalone cap and timeouts.
  test: {
    name: 'pdf-structure',
    include: ['test/**/*.test.ts'],
    maxWorkers: Math.min(4, Math.max(availableParallelism() - 1, 1)),
    testTimeout: 15000,
    hookTimeout: 30000
  }
})
