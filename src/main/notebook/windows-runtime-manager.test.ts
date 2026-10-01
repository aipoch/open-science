import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WindowsRuntimeComponentStore } from './windows-runtime-components'
import { WindowsNotebookRuntimeManager } from './windows-runtime-manager'

afterEach(() => vi.restoreAllMocks())

it('restores a saved Core binding offline without treating standard execution as protection proof', async () => {
  const select = vi
    .spyOn(WindowsRuntimeComponentStore.prototype, 'select')
    .mockImplementation(async (releases, request) => {
      return {
        release: releases.find((release) => release.component === request.component)!,
        root: tmpdir(),
        executable: join(tmpdir(), `${request.component}.exe`)
      }
    })
  const manager = new WindowsNotebookRuntimeManager(
    join(tmpdir(), 'fixture-runtime-manager'),
    vi.fn(),
    undefined,
    'x64'
  )
  await manager.prepare(false, undefined, 'standard')
  expect(
    select.mock.calls.every(
      ([, request]) => !request.allowDownload && request.verifyCompatibility === false
    )
  ).toBe(true)
  expect(() => manager.getProtected()).toThrow('verification is required')
  await manager.prepare(false)
  expect(select).toHaveBeenCalledTimes(4)
  expect(
    select.mock.calls.slice(2).every(([, request]) => request.verifyCompatibility === true)
  ).toBe(true)
  expect(manager.getProtected()).toBe(manager.get())
  await expect(manager.prepare(true, undefined, 'standard')).rejects.toThrow('does not download')
})

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
      if (request.component === 'powershell') throw new Error('component unavailable')
      return { release: releases[0]!, root: tmpdir(), executable: join(tmpdir(), 'node.exe') }
    })
  const manager = new WindowsNotebookRuntimeManager(
    join(tmpdir(), 'fixture-runtime-manager'),
    vi.fn(),
    undefined,
    'x64'
  )
  await expect(manager.prepare(false)).rejects.toThrow('component unavailable')
  expect(() => manager.get()).toThrow('not ready')
  expect(select.mock.calls.every(([, request]) => !request.allowDownload)).toBe(true)
})
