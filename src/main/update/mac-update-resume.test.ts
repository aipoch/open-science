import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MacUpdateRecovery } from './mac-update-handoff'
import { resumeMacUpdateHandoff } from './mac-update-resume'

const bytes = Buffer.from('original verified Mac ZIP')
let root: string
let recovery: Extract<MacUpdateRecovery, { state: 'resume' }>
class NativeUpdater extends EventEmitter {
  url = ''
  setFeedURL = vi.fn(({ url }: { url: string }) => {
    this.url = url
  })
  checkForUpdates = vi.fn()
  quitAndInstall = vi.fn()
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mac-native-resume-'))
  const installerPath = join(root, 'update.zip')
  await writeFile(installerPath, bytes)
  recovery = {
    state: 'resume',
    handoff: vi.fn(),
    dispose: vi.fn(),
    request: {
      schema: 1,
      channel: 'mac-electron-updater',
      operationId: '11111111-1111-4111-8111-111111111111',
      applicationPath: join(root, 'app.app'),
      installerPath,
      installerUrl: 'https://original.example/1.0.9.zip',
      installerSha512: createHash('sha512').update(bytes).digest('base64'),
      targetVersion: '1.0.9',
      profilePath: join(root, 'profile'),
      startupOptions: {
        configRoot: root,
        dataRoot: root,
        profilePath: join(root, 'profile'),
        port: 0,
        host: '127.0.0.1',
        credentialStore: 'file'
      },
      targetManifest: { version: '1.0.9', files: {} }
    }
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('original target replay through native Squirrel', () => {
  it('serves only the bound ZIP over loopback and leaves launch to native quitAndInstall', async () => {
    const updater = new NativeUpdater()
    const requests: Promise<void>[] = []
    updater.checkForUpdates.mockImplementation(() => {
      requests.push(
        (async () => {
          try {
            const url = new URL(updater.url)
            expect(url.hostname).toBe('127.0.0.1')
            const feed = (await (await fetch(url)).json()) as { name: string; url: string }
            expect(feed.name).toBe('1.0.9')
            expect(Buffer.from(await (await fetch(feed.url)).arrayBuffer())).toEqual(bytes)
            const partial = await fetch(feed.url, { headers: { Range: 'bytes=3-7' } })
            expect(partial.status).toBe(206)
            expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(3, 8))
            expect((await fetch(feed.url, { headers: { Range: 'bytes=999-' } })).status).toBe(416)
            expect((await fetch(url.origin + '/update.zip')).status).toBe(404)
            updater.emit('update-downloaded')
          } catch (error) {
            updater.emit('error', error)
          }
        })()
      )
    })
    await resumeMacUpdateHandoff(recovery, updater)
    await Promise.all(requests)
    expect(recovery.handoff).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(recovery.dispose).not.toHaveBeenCalled() // Lease belongs to Desktop until native quit.
    expect(updater.listenerCount('update-downloaded')).toBe(0)
    expect(updater.listenerCount('error')).toBe(0)
    await expect(fetch(updater.url)).rejects.toThrow()
  })

  it('retains context and cleans its listener/server after native signature rejection', async () => {
    const updater = new NativeUpdater()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('error', new Error('native signature rejected'))
    })
    await expect(resumeMacUpdateHandoff(recovery, updater)).rejects.toThrow(
      'native signature rejected'
    )
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(recovery.handoff).not.toHaveBeenCalled()
    expect(updater.listenerCount('error')).toBe(0)
    expect(await readFile(recovery.request.installerPath)).toEqual(bytes)
  })

  it('bounds native preparation and never announces installation after timeout', async () => {
    const updater = new NativeUpdater()
    await expect(resumeMacUpdateHandoff(recovery, updater, { timeoutMs: 25 })).rejects.toThrow()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(recovery.handoff).not.toHaveBeenCalled()
    expect(updater.listenerCount('update-downloaded')).toBe(0)
    await expect(fetch(updater.url)).rejects.toThrow()
  })

  it('rejects changed cached bytes before setting the native feed', async () => {
    const updater = new NativeUpdater()
    await writeFile(recovery.request.installerPath, 'corrupt')
    await expect(resumeMacUpdateHandoff(recovery, updater)).rejects.toThrow('checksum')
    expect(updater.setFeedURL).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
