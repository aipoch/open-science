import { link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createManagedOutputAuthority,
  revokeManagedOutputAuthority,
  type ManagedOutputAuthority
} from '../notebook/managed-output-authority'
import { readObservationProjectExport } from './project-export-reader'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const scope = { projectId: 'p', sessionId: 's', operationId: 'o' }
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture() {
  const base = await fs.realpath(await mkdtemp(join(tmpdir(), 'observation-export-')))
  roots.push(base)
  const root = join(base, 'output')
  await mkdir(root)
  const path = join(root, 'frame.png')
  const bytes = Buffer.alloc(150000, 17)
  await writeFile(path, bytes)
  const authority = createManagedOutputAuthority({ ...scope, outputRoot: root })
  const controller = new AbortController()
  const input = { authority, scope, path: 'frame.png', signal: controller.signal }
  return { base, root, path, bytes, authority, input, controller }
}
async function afterFirstRead(effect: () => Promise<void> | void): Promise<void> {
  const originalOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    const read = handle.read.bind(handle)
    let first = true
    vi.spyOn(handle, 'read').mockImplementation(
      async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs)
        if (first) {
          first = false
          await effect()
        }
        return result
      }
    )
    return handle
  })
}

describe('declared observation project export reader', () => {
  it('reads bounded exact bytes from the same opened sandbox file including nested output paths', async () => {
    const h = await fixture()
    await mkdir(join(h.root, 'images'))
    await rename(h.path, join(h.root, 'images/frame.png'))
    expect(await readObservationProjectExport({ ...h.input, path: 'images/frame.png' })).toEqual({
      bytes: h.bytes
    })
  })

  it('requires the actual Main capability, exact scope and a safe predeclared relative path', async () => {
    const h = await fixture()
    for (const extra of [
      { authority: {} as ManagedOutputAuthority },
      { scope: { ...scope, sessionId: 'other' } },
      { scope: { ...scope, operationId: 'other' } },
      { path: h.path },
      { path: '../output/frame.png' },
      { path: 'images/../frame.png' },
      { path: 'frame.png/..' }
    ])
      await expect(readObservationProjectExport({ ...h.input, ...extra })).rejects.toThrow(
        'The declared observation image is unavailable.'
      )
  })

  it('refuses final and intermediate symlinks, multiply linked files and oversize files', async () => {
    const h = await fixture()
    await symlink(h.path, join(h.root, 'linked.png'))
    await symlink(h.root, join(h.root, 'linked-dir'))
    await link(h.path, join(h.root, 'hard.png'))
    for (const path of ['linked.png', 'linked-dir/frame.png', 'hard.png', 'frame.png'])
      await expect(readObservationProjectExport({ ...h.input, path })).rejects.toThrow(
        'The declared observation image is unavailable.'
      )
    await rm(join(h.root, 'hard.png'))
    await truncate(h.path, 16 * 1024 * 1024 + 1)
    await expect(readObservationProjectExport(h.input)).rejects.toThrow(
      'The declared observation image is unavailable.'
    )
  })

  it.each(['replace', 'modify', 'truncate', 'hardlink'] as const)(
    'rejects %s after the file was opened and closes its descriptor',
    async (mutation) => {
      const h = await fixture()
      await afterFirstRead(async () => {
        if (mutation === 'replace') {
          await rename(h.path, `${h.path}.old`)
          await writeFile(h.path, h.bytes)
        } else if (mutation === 'modify') await writeFile(h.path, Buffer.alloc(h.bytes.length, 18))
        else if (mutation === 'truncate') await truncate(h.path, 4)
        else await link(h.path, `${h.path}.hard`)
      })
      await expect(readObservationProjectExport(h.input)).rejects.toThrow(
        'The declared observation image is unavailable.'
      )
      const handle = await vi.mocked(fs.open).mock.results[0].value
      expect(handle.fd).toBe(-1)
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'asks the macOS kernel to reject a symlink swapped into any ancestor during open',
    async () => {
      const h = await fixture()
      const images = join(h.root, 'images')
      await mkdir(images)
      await rename(h.path, join(images, 'frame.png'))
      const realOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open
      let openError: unknown
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        await rename(images, `${images}.original`)
        await symlink(`${images}.original`, images)
        try {
          return await realOpen(...args)
        } catch (error) {
          openError = error
          throw error
        } finally {
          await rm(images)
          await rename(`${images}.original`, images)
        }
      })
      await expect(
        readObservationProjectExport({ ...h.input, path: 'images/frame.png' })
      ).rejects.toThrow('The declared observation image is unavailable.')
      expect(openError).toMatchObject({ code: 'ELOOP' })
    }
  )

  it.each(['caller', 'lease'] as const)(
    'honors %s cancellation before returning any bytes',
    async (kind) => {
      const h = await fixture()
      await afterFirstRead(() => {
        if (kind === 'caller') h.controller.abort()
        else revokeManagedOutputAuthority(h.authority)
      })
      await expect(readObservationProjectExport(h.input)).rejects.toThrow(
        'The declared observation image is unavailable.'
      )
    }
  )
})
