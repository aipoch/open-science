import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'

const resolvedConfig = (config as (input: { command: 'build'; mode: string }) => unknown)({
  command: 'build',
  mode: 'production'
})

describe('electron-vite main process dependencies', () => {
  it('bundles the source-only Notebook network sandbox package', () => {
    expect(resolvedConfig).toMatchObject({
      main: {
        build: {
          externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
        }
      }
    })
  })
})

describe('electron-vite renderer dependency optimization', () => {
  it('pre-bundles worker-only dependencies so lazy workers do not trigger a dev reload', () => {
    // These packages are imported only by `new Worker(new URL(...))` modules, which Vite's dep
    // scanner cannot reach. Include every bare import of:
    // - src/renderer/src/components/streamdown/markdown-parser.worker.ts
    // - src/renderer/src/pages/workspace/pdf-annotations/pdf-export.ts (via pdf-export-worker.ts)
    // - src/renderer/src/pages/workspace/previews/tiff-preview.ts (via tiff-preview-worker.ts)
    expect(resolvedConfig).toMatchObject({
      renderer: {
        optimizeDeps: {
          include: expect.arrayContaining([
            'unified',
            'remark-parse',
            'remark-gfm',
            'remark-math',
            'pdf-lib',
            'tiff'
          ])
        }
      }
    })
  })
})
