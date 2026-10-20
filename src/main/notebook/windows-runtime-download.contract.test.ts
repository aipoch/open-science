import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { resilientDownload } from '@aipoch/resilient-download'
import { netFetchStandard } from '../network-fetch'
import type {
  WindowsRuntimeComponentDependencies,
  WindowsRuntimeComponentRelease
} from './windows-runtime-components'
import catalog from './windows-runtime-catalog.json'
import { WindowsNotebookRuntimeManager } from './windows-runtime-manager'

const captured = vi.hoisted(() => ({
  dependencies: undefined as WindowsRuntimeComponentDependencies | undefined
}))
vi.mock('./windows-runtime-components', async (original) => ({
  ...(await original<typeof import('./windows-runtime-components')>()),
  WindowsRuntimeComponentStore: class {
    constructor(_root: string, dependencies: WindowsRuntimeComponentDependencies) {
      captured.dependencies = dependencies
    }
  }
}))
vi.mock('@aipoch/resilient-download', () => ({
  resilientDownload: vi.fn(async (_url, path) => path)
}))

it('maps the pinned Windows release into the proxy-aware downloader without changing progress', async () => {
  const root = join(tmpdir(), 'runtime-contract-no-io')
  new WindowsNotebookRuntimeManager(root, vi.fn(), undefined, 'x64')
  const release = catalog.releases[0] as unknown as WindowsRuntimeComponentRelease
  const controller = new AbortController()
  const progress = vi.fn()
  const destination = join(root, 'component.tar.zst')
  await captured.dependencies!.download(release, destination, controller.signal, progress)
  const [url, path, options] = vi.mocked(resilientDownload).mock.calls[0]
  expect([url, path]).toEqual([release.archive.url, destination])
  expect(options).toMatchObject({
    expectedSize: release.archive.size,
    expectedSha256: release.archive.sha256,
    signal: controller.signal,
    fetchImpl: netFetchStandard,
    stallTimeoutMs: 60_000
  })
  const value = {
    phase: 'reconnecting' as const,
    transferred: 12,
    total: 42,
    bytesPerSecond: 0,
    attempt: 1
  }
  options!.onProgress!(value)
  expect(progress).toHaveBeenCalledExactlyOnceWith(12, 42, value)
})
