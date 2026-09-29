import { resolve } from 'node:path'
import type { TransformPluginContext } from 'rollup'
import { resolveConfig, type UserConfig } from 'vite'
import { describe, expect, it, vi } from 'vitest'

import config from '../electron.vite.config'

const resolvedConfig = (
  config as (input: { command: 'build'; mode: string }) => { main: UserConfig }
)({
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
      },
      renderer: {
        server: { host: '127.0.0.1' }
      }
    })
  })

  it('leaves generated node-worker wrappers as JavaScript while compiling worker TypeScript', async () => {
    const viteConfig = await resolveConfig(
      { configFile: false, envFile: false, esbuild: resolvedConfig.main.esbuild },
      'build'
    )
    const hook = viteConfig.plugins.find((plugin) => plugin.name === 'vite:esbuild')?.transform
    if (!hook) throw new Error('Vite esbuild transform is required for worker TypeScript')
    const transform = typeof hook === 'function' ? hook : hook.handler
    const context = { warn: vi.fn() } as unknown as TransformPluginContext
    const wrapper =
      "import { Worker } from 'node:worker_threads'; export default function (options) { return new Worker(new URL('__VITE_NODE_WORKER_ASSET__test__', import.meta.url), options); }"

    for (const id of [
      `../session-diagnostics/worker-entry?nodeWorker&importer=${resolve('src/main/composition/session-foundation.ts')}`,
      `../session-package/inspection-worker-entry?nodeWorker&importer=${resolve('src/main/composition/session-packages.ts')}`,
      `./native-import-worker-entry?nodeWorker&importer=${resolve('src/main/pdf-annotations/native-import.ts')}`,
      '../session-diagnostics/worker-entry?nodeWorker&importer=C:/repo/src/main/composition/session-foundation.ts'
    ]) {
      expect(await transform.call(context, wrapper, id)).toBeUndefined()
    }

    const result = await transform.call(
      context,
      'export const value: number = 42',
      resolve('src/main/session-diagnostics/worker-entry.ts')
    )
    expect(result).toMatchObject({ code: expect.stringContaining('export const value = 42') })
    expect(
      await transform.call(context, 'export const value = 42', resolve('worker.js'))
    ).toBeUndefined()
  })
})
