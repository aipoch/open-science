import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRuntimeControl, RUNTIME_OWNER_FILE, type RuntimeOwnerRecord } from './runtime-control'
import { requestExistingRuntimeWeb } from '../../packages/open-science/runtime-control.mjs'
import type { DesktopEndpoint } from './desktop-connection'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function runtime(host: 'node' | 'electron', desktop?: DesktopEndpoint) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-control-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ensureWeb = vi.fn().mockResolvedValue(undefined)
  const control = await startRuntimeControl(root, host, ensureWeb, desktop)
  cleanup.push(() => control.close())
  const record = JSON.parse(
    await readFile(join(root, RUNTIME_OWNER_FILE), 'utf8')
  ) as RuntimeOwnerRecord
  const token = (await readFile(join(root, 'web-token'), 'utf8')).trim()
  return { root, ensureWeb, control, record, token }
}
describe('runtime ownership discovery', () => {
  it('keeps desktop credentials in the private owner file and out of Web-authenticated discovery', async () => {
    const desktop = {
      path: 'private-test-endpoint',
      generation: 'desktop-generation',
      secret: 'desktop-only-secret',
      version: 'test'
    }
    const { root, record, token, control } = await runtime('node', desktop)
    expect(record.desktop).toEqual(desktop)
    if (process.platform !== 'win32')
      expect((await stat(join(root, RUNTIME_OWNER_FILE))).mode & 0o777).toBe(0o600)
    const response = await fetch(`http://127.0.0.1:${record.port}/owner`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-open-science-runtime-generation': record.generation
      }
    })
    expect(await response.json()).toEqual({ generation: record.generation, pid: record.pid })
    await control.close()
    await expect(readFile(join(root, RUNTIME_OWNER_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['node', 'electron'] as const)(
    'reuses an authenticated %s owner and keeps credential selection read-only',
    async (host) => {
      const value = await runtime(host)
      await expect(
        requestExistingRuntimeWeb({ configRoot: value.root, port: 45100 })
      ).resolves.toBe(value.root)
      expect(value.ensureWeb).toHaveBeenCalledExactlyOnceWith(45100)
      await expect(
        requestExistingRuntimeWeb({ configRoot: value.root, credentialStore: 'os' })
      ).rejects.toThrow('already running')
      expect(value.ensureWeb).toHaveBeenCalledTimes(1)
    }
  )
  it('rejects missing authentication and stale generations before starting Web', async () => {
    const { record, token, ensureWeb } = await runtime('electron')
    const url = `http://127.0.0.1:${record.port}/web/start?port=44100`
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-open-science-runtime-generation': 'old' }
        })
      ).status
    ).toBe(409)
    expect(ensureWeb).not.toHaveBeenCalled()
  })
  it('removes only its own generation on shutdown', async () => {
    const { root, record, control } = await runtime('node')
    const path = join(root, RUNTIME_OWNER_FILE)
    const next = { ...record, generation: 'replacement' }
    await writeFile(path, JSON.stringify(next))
    await control.close()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(next)
  })
})
