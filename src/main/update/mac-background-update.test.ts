import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutoUpdater } from 'electron'
import { expect, it, vi } from 'vitest'
import { planMacUpdateOnQuit, canDownloadMacUpdate } from './mac-background-update'
import type { UpdateStrategy } from './strategy'
import type { UpdateStatus } from '../../shared/update'

it('declines automatic downloads when the system path probe is unavailable', async () => {
  expect(await canDownloadMacUpdate(tmpdir(), tmpdir(), 1024)).toBe(false)
})

it.runIf(process.platform === 'darwin')(
  'keeps translocated, trashed and unwritable installations on the manual path',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac-download-location-'))
    const parent = join(dir, 'Applications')
    const bundle = join(parent, 'Open-Science.app')
    try {
      const binaries = join(bundle, 'Contents/MacOS')
      await mkdir(binaries, { recursive: true })
      await writeFile(join(binaries, 'mac-update-network'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      expect(await canDownloadMacUpdate(bundle, dir, 1024)).toBe(true)
      await chmod(parent, 0o555)
      expect(await canDownloadMacUpdate(bundle, dir, 1024)).toBe(false)
      await chmod(parent, 0o755)
      for (const name of ['AppTranslocation', '.Trash']) {
        const moved = join(dir, name)
        await rename(parent, moved)
        expect(await canDownloadMacUpdate(join(moved, 'Open-Science.app'), dir, 1024)).toBe(false)
        await rename(moved, parent)
      }
    } finally {
      await chmod(parent, 0o755).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'only stages an intact, admitted local ZIP and waits for native readiness',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mac-quit-update-'))
    try {
      const { execFileSync } = await import('node:child_process')
      const { readFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'payload'), 'verified bytes')
      execFileSync('/usr/bin/zip', ['-q', 'next.zip', 'payload'], { cwd: dir })
      const archive = join(dir, 'next.zip')
      const status: UpdateStatus = {
        current: '1',
        latest: '2',
        state: 'ready',
        automaticDownloads: false,
        localPath: archive,
        artifactSha512: createHash('sha512')
          .update(await readFile(archive))
          .digest('base64')
      }
      const strategy = {
        getStatus: () => status,
        getInstaller: async () => ({ format: 'zip' })
      } as UpdateStrategy
      const native = Object.assign(new EventEmitter(), {
        getFeedURL: () => 'http://127.0.0.1:12345',
        checkForUpdates: vi.fn()
      })
      const occupied = vi.fn(async () => {
        throw new Error('occupied')
      })
      const prepare = (
        inspect = async (): Promise<void> => {}
      ): ReturnType<typeof planMacUpdateOnQuit> =>
        planMacUpdateOnQuit(strategy, native as unknown as AutoUpdater, dir, dir, inspect)
      expect(await prepare()).toBe(false)
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      status.automaticDownloads = true
      await expect(prepare(occupied)).rejects.toThrow('occupied')
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      const plan = await prepare()
      if (!plan) throw new Error('Expected an admitted update')
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      const staged = plan()
      await vi.waitFor(() => expect(native.checkForUpdates).toHaveBeenCalledOnce())
      native.emit('update-downloaded')
      await staged
      expect(native.listenerCount('error')).toBe(0)
      await writeFile(archive, 'changed')
      await expect(prepare()).rejects.toThrow('checksum')
      expect(native.checkForUpdates).toHaveBeenCalledOnce()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)
