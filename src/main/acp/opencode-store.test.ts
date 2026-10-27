import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireOpenCodeStore, type OpenCodeStoreLease } from './opencode-store'
import { acquireRuntimeDirectorySync } from '../runtime-ownership'

const roots: string[] = []
const leases: OpenCodeStoreLease[] = []
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'opencode-store-'))
  roots.push(path)
  return path
}
const acquire = async (path: string, major: 1 | 2): Promise<OpenCodeStoreLease> => {
  const lease = await acquireOpenCodeStore(path, major)
  leases.push(lease)
  return lease
}
afterEach(async () => {
  leases.splice(0).forEach((lease) => lease.release())
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('OpenCode storage upgrade policy', () => {
  it('allows legacy history, durably marks an upgrade, then rejects downgrade before launch', async () => {
    const path = await root()
    ;(await acquire(path, 1)).release()
    await expect(
      readFile(join(path, 'opencode', 'open-science-runtime-version.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    ;(await acquire(path, 2)).release()
    expect(
      JSON.parse(
        await readFile(join(path, 'opencode', 'open-science-runtime-version.json'), 'utf8')
      )
    ).toEqual({ minimumMajorVersion: 2 })
    await expect(acquire(path, 1)).rejects.toThrow('Downgrading is not supported')
    ;(await acquire(path, 2)).release()
  })

  it('shares same-version leases but refuses migration until all old writers have stopped', async () => {
    const path = await root()
    const [first, second] = await Promise.all([acquire(path, 1), acquire(path, 1)])
    first.release()
    first.release()
    await expect(acquire(path, 2)).rejects.toThrow('Close existing OpenCode sessions')
    expect(() => acquireRuntimeDirectorySync(join(path, 'opencode'))).toThrow('already using')
    second.release()
    ;(await acquire(path, 2)).release()
    const lock = acquireRuntimeDirectorySync(join(path, 'opencode'))
    lock.release()
  })

  it.each(['broken json', '{"minimumMajorVersion":3}', '{"minimumMajorVersion":1}'])(
    'fails closed for unreadable or unsupported marker %s',
    async (marker) => {
      const path = await root()
      await mkdir(join(path, 'opencode'))
      await writeFile(join(path, 'opencode', 'open-science-runtime-version.json'), marker)
      await expect(acquire(path, 2)).rejects.toThrow()
      expect(
        await readFile(join(path, 'opencode', 'open-science-runtime-version.json'), 'utf8')
      ).toBe(marker)
    }
  )

  it('does not prevent a separate delegated store from using another version', async () => {
    await acquire(await root(), 2)
    await acquire(await root(), 1)
  })
})
