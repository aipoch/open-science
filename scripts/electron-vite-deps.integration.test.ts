import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveConfig } from 'electron-vite'
import { createServer, normalizePath } from 'vite'
import { expect, it, vi } from 'vitest'

it('serves lazy Worker modules without late optimization or full reloads', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'open-science-vite-deps-'))
  const root = resolve('.')
  const installRoot = basename(dirname(root)) === '.worktree' ? resolve('../..') : root
  const { config } = await resolveConfig({}, 'serve')
  const server = await createServer({
    ...config!.renderer,
    configFile: false,
    cacheDir,
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null,
      // Worktrees can reuse the parent checkout's installed dependencies.
      fs: { allow: [root, installRoot] }
    }
  })
  try {
    const optimizer = server.environments.client.depsOptimizer!
    const send = vi.spyOn(server.environments.client.hot, 'send')
    await optimizer.scanProcessing
    await Promise.all(Object.values(optimizer.metadata.discovered).map((dep) => dep.processing))
    const initial = Object.keys(optimizer.metadata.optimized).sort()
    expect(initial).toEqual(
      expect.arrayContaining([
        'react',
        'unified',
        'remark-parse',
        'remark-gfm',
        'remark-math',
        'pdf-lib',
        'tiff',
        'papaparse',
        'fflate',
        'styled-exceljs',
        'tinycolor2',
        '@xmldom/xmldom',
        'jszip'
      ])
    )
    const spreadsheetRoot = dirname(
      createRequire(import.meta.url).resolve(
        '@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker'
      )
    )
    // Worker URL imports and third-party Worker modules are invisible to the HTML-only scan.
    const requests = [
      '/src/components/streamdown/markdown-parser.worker.ts?worker_file&type=module',
      '/src/pages/workspace/pdf-annotations/pdf-export-worker.ts?worker_file&type=module',
      '/src/pages/workspace/pdf-annotations/pdf-export.ts',
      '/src/pages/workspace/previews/tiff-preview-worker.ts?worker_file&type=module',
      '/src/pages/workspace/previews/tiff-preview.ts',
      '/src/pages/literature/journals/journal-import.worker.ts?worker_file&type=module',
      '/src/pages/literature/journals/journal-import-file.ts',
      ...['sheet.worker.js', 'parser.js', 'SheetJsModel.js', 'color.js', 'chartParser.js'].map(
        (file) => `/@fs/${normalizePath(join(spreadsheetRoot, file))}`
      )
    ]
    for (const request of requests) {
      expect(await server.transformRequest(request)).not.toBeNull()
      await server.waitForRequestsIdle()
      await Promise.all(Object.values(optimizer.metadata.discovered).map((dep) => dep.processing))
    }
    expect(Object.keys(optimizer.metadata.optimized).sort()).toEqual(initial)
    expect(Object.keys(optimizer.metadata.discovered)).toEqual([])
    expect(send.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'full-reload' })])
    )
  } finally {
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}, 90_000)
