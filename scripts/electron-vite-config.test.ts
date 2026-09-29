import { createRequire } from 'node:module'
import { normalizePath } from 'vite'
import type { UserConfig } from 'electron-vite'
import { describe, expect, it } from 'vitest'

import config from '../electron.vite.config'

const resolveConfig = config as (input: { command: 'build' | 'serve'; mode: string }) => UserConfig
const resolvedConfig = resolveConfig({ command: 'build', mode: 'production' })

describe('electron-vite main process dependencies', () => {
  it('bundles the source-only Notebook network sandbox package', () => {
    expect(resolvedConfig).toMatchObject({
      main: {
        build: {
          externalizeDeps: { exclude: ['@aipoch/notebook-network-sandbox'] }
        }
      },
      renderer: {
        server: { host: '127.0.0.1' }
      }
    })
  })
})

describe('electron-vite renderer dependency optimization', () => {
  it('scans HTML and lazy Worker entries only during development', () => {
    const dev = resolveConfig({ command: 'serve', mode: 'development' })
    expect(dev.renderer?.optimizeDeps).toEqual({
      force: true,
      entries: [
        '*.html',
        'src/**/*.worker.ts',
        'src/**/*-worker.ts',
        normalizePath(
          createRequire(import.meta.url).resolve(
            '@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker'
          )
        )
      ]
    })
    expect(resolvedConfig.renderer?.optimizeDeps).toBeUndefined()
    expect(dev.renderer?.build).toEqual(resolvedConfig.renderer?.build)
    expect(dev.renderer?.worker).toEqual(resolvedConfig.renderer?.worker)
  })
})
