import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutoUpdater } from 'electron'
import { expect, it, vi } from 'vitest'
import { prepareMacUpdateOnQuit, canDownloadMacUpdate } from './mac-background-update'
import type { UpdateStrategy } from './strategy'
import type { UpdateStatus } from '../../shared/update'

it('declines automatic downloads when the system path probe is unavailable', async () => {
  expect(await canDownloadMacUpdate(tmpdir(), tmpdir(), 1024)).toBe(false)
})

it.runIf(process.platform === 'darwin')(
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
      const prepare = (inspect = async (): Promise<void> => {}) =>
        prepareMacUpdateOnQuit(strategy, native as unknown as AutoUpdater, dir, dir, inspect)
      await prepare()
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      status.automaticDownloads = true
      await expect(prepare(occupied)).rejects.toThrow('occupied')
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      const staged = prepare()
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
