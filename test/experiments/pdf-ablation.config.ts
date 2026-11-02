import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { variants } from '../../scripts/pdf-ablation.mjs'

const variant = variants.find((item) => item.name === process.env.PDF_ABLATION_VARIANT)
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src/renderer/src', import.meta.url)),
      '@renderer': fileURLToPath(new URL('../../src/renderer/src', import.meta.url))
    }
  },
  plugins: [
    {
      name: 'isolated-pdf-ablation',
      enforce: 'pre',
      transform(code, id) {
        if (!variant || !id.split('?')[0].endsWith('/' + variant.file)) return
        const matches = code.split(variant.from).length - 1
        if (matches !== 1)
          throw new Error(`Ablation anchor must be unique: ${variant.name}, found ${matches}`)
        return { code: code.replace(variant.from, variant.to), map: null }
      }
    }
  ],
  test: {
    setupFiles: ['./test/setup-jsdom-polyfills.ts', './test/setup-i18n.ts'],
    include: [
      'src/main/uploads/attachment-media.test.ts',
      'src/main/uploads/pdf-ocr.test.ts',
      'src/main/uploads/pdf-ocr.integration.test.ts',
      'packages/literature-reading/test/reader.test.ts',
      'test/experiments/pdf-worker-lifetime.test.ts',
      'test/experiments/pdf-ablation-validation.test.ts',
      'src/main/literature/mcp-server.test.ts',
      'src/main/acp/runtime-events.test.ts',
      'src/renderer/src/pages/workspace/pdf-text-coverage.test.tsx'
    ],
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 15000,
    hookTimeout: 30000
  }
})
