import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronState = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.0',
    getName: () => 'LocalUpdateValidation',
    getPath: () => electronState.root,
    whenReady: async () => {}
  },
  session: { fromPartition: () => ({}) },
  // ElectronHttpExecutor retains the real updater request/download/checksum implementation.
  // Node HTTP is the test transport; no fake updater lifecycle events are supplied.
  net: { request: (options: Parameters<typeof request>[0]) => request(options) }
}))
import { LocalMacDownloadUpdater } from './adapter'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove()
})
async function setup(corrupt: boolean): Promise<{
  updater: LocalMacDownloadUpdater
  expected: Buffer
  checksum: string
  bytesServed(): number
}> {
  const require = createRequire(import.meta.url)
  const electronEntry = require.resolve('electron')
  const previousModule = require.cache[electronEntry]
  const mockExports = {
    app: {
      isPackaged: true,
      getVersion: () => '0.1.0',
      getName: () => 'LocalUpdateValidation',
      getPath: () => electronState.root,
      whenReady: async () => {}
    },
    session: { fromPartition: () => ({}) },
    net: { request: (options: Parameters<typeof request>[0]) => request(options) }
  }
  require.cache[electronEntry] = { exports: mockExports } as NodeModule
  cleanup.push(async () => {
    if (previousModule) require.cache[electronEntry] = previousModule
    else delete require.cache[electronEntry]
  })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-updater-test-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  electronState.root = root
  const expected = Buffer.from('target B application archive, same workspace snapshot')
  const payload = corrupt ? Buffer.from('damaged target B archive') : expected
  const checksum = createHash('sha512').update(expected).digest('base64')
  const feed = {
    version: '0.2.0',
    files: [{ url: 'target.zip', size: expected.length, sha512: checksum }],
    path: 'target.zip',
    sha512: checksum,
    releaseDate: new Date().toISOString()
  }
  let bytesServed = 0
  const server = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/latest')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(feed))
    } else if (incoming.url === '/target.zip') {
      bytesServed += payload.length
      response.writeHead(200, { 'Content-Length': payload.length })
      response.end(payload)
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address() as { port: number }
  const metadata = join(root, 'updater.yml')
  await writeFile(metadata, 'updaterCacheDirName: local-update-validation\n')
  const updater = new LocalMacDownloadUpdater(`http://127.0.0.1:${address.port}/`, root, metadata)
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = null
  return { updater, expected, checksum, bytesServed: () => bytesServed }
}

describe('local macOS download adapter', () => {
  it('checks a real feed and downloads a ZIP through the production SHA512 verifier', async () => {
    const { updater, expected, checksum, bytesServed } = await setup(false)
    const downloaded = vi.fn()
    updater.on('update-downloaded', downloaded)
    expect((await updater.checkForUpdates())?.updateInfo.version).toBe('0.2.0')
    const paths = await updater.downloadUpdate()
    expect(bytesServed()).toBe(expected.length)
    expect(await readFile(paths[0])).toEqual(expected)
    expect(downloaded).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadedFile: paths[0],
        files: [expect.objectContaining({ sha512: checksum })]
      })
    )
    expect(() => updater.quitAndInstall()).toThrow('Native installation is disabled')
  })
  it('rejects a corrupted network artifact without publishing downloaded readiness', async () => {
    const { updater, bytesServed } = await setup(true)
    const downloaded = vi.fn()
    updater.on('update-downloaded', downloaded)
    await updater.checkForUpdates()
    await expect(updater.downloadUpdate()).rejects.toThrow(/checksum/i)
    expect(bytesServed()).toBeGreaterThan(0)
    expect(downloaded).not.toHaveBeenCalled()
  })
})
