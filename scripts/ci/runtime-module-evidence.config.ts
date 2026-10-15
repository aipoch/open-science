import base from '../../vitest.config'
import { runtimeEvidenceSample } from './runtime-module-evidence.mjs'

export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      provider: 'v8',
      reporter: ['json'],
      include: runtimeEvidenceSample.sources,
      exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
      // Partial diagnostic observations must not apply full-suite coverage thresholds.
      thresholds: undefined
    }
  }
}
