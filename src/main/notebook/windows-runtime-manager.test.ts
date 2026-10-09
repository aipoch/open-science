import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WindowsRuntimeComponentStore } from './windows-runtime-components'
import { WindowsNotebookRuntimeManager } from './windows-runtime-manager'

afterEach(() => vi.restoreAllMocks())

it('prepares both components only on explicit setup and reuses that selection for later cells', async () => {
  const select = vi
    .spyOn(WindowsRuntimeComponentStore.prototype, 'select')
    .mockImplementation(async (releases, request) => {
      const release = releases.find((value) => value.component === request.component)!
      const root = join(tmpdir(), 'fixture', request.component)
      return {
        release,
        root,
        executable: join(root, request.component === 'node' ? 'node.exe' : 'pwsh.exe')
      }
    })
  const manager = new WindowsNotebookRuntimeManager(
    join(tmpdir(), 'fixture-runtime-manager'),
    vi.fn(),
    undefined,
    'x64'
  )
  expect(() => manager.get()).toThrow('not ready')
  const first = await manager.prepare(true)
  expect(first.node).toContain('node.exe')
  expect(first.powershell).toContain('pwsh.exe')
  expect(select).toHaveBeenCalledTimes(2)
  expect(select.mock.calls.every(([, request]) => request.allowDownload)).toBe(true)
  expect(await manager.prepare(false)).toBe(first)
  expect(select).toHaveBeenCalledTimes(2)
})

it('does not expose a half-prepared runtime when the second component fails', async () => {
  const select = vi
    .spyOn(WindowsRuntimeComponentStore.prototype, 'select')
    .mockImplementation(async (releases, request) => {
      if (request.component === 'powershell') {
        request.onProgress?.({ component: 'powershell', phase: 'verifying' })
        throw new Error('component unavailable')
      }
      return { release: releases[0]!, root: tmpdir(), executable: join(tmpdir(), 'node.exe') }
    })
  const manager = new WindowsNotebookRuntimeManager(
    join(tmpdir(), 'fixture-runtime-manager'),
    vi.fn(),
    undefined,
    'x64'
  )
  await expect(manager.prepare(false)).rejects.toThrow('component unavailable')
  expect(manager.failure).toEqual({ component: 'powershell', phase: 'verifying' })
  expect(manager.progress).toBeUndefined()
  expect(() => manager.get()).toThrow('not ready')
  expect(select.mock.calls.every(([, request]) => !request.allowDownload)).toBe(true)
})

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()
